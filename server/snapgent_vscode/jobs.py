"""Calls that outlive the request that started them.

The extension names a call with a job key. A call that comes again with the same key (the page was reloaded while it
ran, or finished) is answered from that job instead of running twice, and a job still running can be cancelled by its
key. The key is set by the extension in a reserved argument the model cannot set; reading tools are not kept as jobs
(running them again is cheap and shows fresh data).
"""

import os
import signal
import subprocess
import threading
import time
from typing import Any, Callable, Dict, List, Optional

JOB_ARGUMENT = "__snapgent_job"
JOB_OP_ARGUMENT = "__snapgent_job_op"   # "cancel"
JOB_LIFETIME_SECONDS = 900
MAX_JOBS = 50
CANCELLED_MESSAGE = "The command was cancelled by the user before it finished."

_current = threading.local()


def current_job() -> Optional["Job"]:
    """The job whose thread this is, so a process started on it can be found and stopped."""
    return getattr(_current, "job", None)


def stop_process(process: "subprocess.Popen[str]") -> None:
    """End a process and what it started (a build spawns many), politely first."""
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True, check=False, timeout=10)
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            process.kill()


class Job:
    def __init__(self, key: str, tool: str, clock: Callable[[], float]) -> None:
        self.key = key
        self.tool = tool
        self.started = clock()
        self.finished: Optional[float] = None
        self.cancelled = False
        self._clock = clock
        self._done = threading.Event()
        self._output: Any = None
        self._error: Optional[str] = None
        self._processes: List["subprocess.Popen[str]"] = []
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return not self._done.is_set()

    def attach(self, process: "subprocess.Popen[str]") -> None:
        """Remember a process this job started; one that starts after a cancel is stopped at once."""
        with self._lock:
            self._processes.append(process)
            stop_now = self.cancelled
        if stop_now:
            stop_process(process)

    def detach(self, process: "subprocess.Popen[str]") -> None:
        with self._lock:
            if process in self._processes:
                self._processes.remove(process)

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
            processes = list(self._processes)
        for process in processes:
            stop_process(process)

    def finish(self, output: Any = None, error: Optional[str] = None) -> None:
        self._output, self._error = output, error
        self.finished = self._clock()
        self._done.set()

    def wait(self, timeout: Optional[float] = None) -> Any:
        """The tool's output; the tool's own failure is raised again, exactly as the first caller saw it."""
        if not self._done.wait(timeout):
            raise TimeoutError(f"The command ({self.tool}) is still running.")
        if self._error is not None:
            raise RuntimeError(self._error)
        return self._output


class JobStore:
    def __init__(self, clock: Callable[[], float] = time.monotonic, lifetime: float = JOB_LIFETIME_SECONDS,
                 max_jobs: int = MAX_JOBS) -> None:
        self._clock = clock
        self._lifetime = lifetime
        self._max_jobs = max_jobs
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Job]:
        with self._lock:
            self._expire()
            return self._jobs.get(key)

    def start(self, key: str, tool: str, task: Callable[[], Any]) -> Job:
        """Run `task` on its own thread under `key`; the caller waits on the returned job (or stops waiting: it goes on)."""
        job = Job(key, tool, self._clock)
        with self._lock:
            self._expire()
            self._jobs[key] = job
        threading.Thread(target=self._run, args=(job, task), daemon=True).start()
        return job

    def cancel(self, key: str) -> str:
        job = self.get(key)
        if job is None:
            return "No such job: it never started, or it was cleared."
        if not job.running:
            return "That command had already finished."
        job.cancel()
        return "Cancelled."

    @staticmethod
    def _run(job: Job, task: Callable[[], Any]) -> None:
        _current.job = job
        try:
            job.finish(output=task())
        except Exception as error:  # the failure is the job's answer, shown to whoever asks
            job.finish(error=CANCELLED_MESSAGE if job.cancelled else (str(error) or type(error).__name__))
        finally:
            _current.job = None

    def _expire(self) -> None:
        """Forget finished jobs past their lifetime, then the oldest finished ones beyond the limit (a running job stays)."""
        now = self._clock()
        for key in [k for k, job in self._jobs.items() if job.finished is not None and now - job.finished > self._lifetime]:
            del self._jobs[key]
        finished = sorted((j for j in self._jobs.values() if j.finished is not None), key=lambda j: j.finished or 0)
        while len(self._jobs) > self._max_jobs and finished:
            del self._jobs[finished.pop(0).key]
