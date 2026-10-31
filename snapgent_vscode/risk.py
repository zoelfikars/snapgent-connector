"""What a tool can do to the user's machine. The security policy decides per level."""

READ = "read"                # observes the workspace
WRITE = "write"              # creates or changes files inside the workspace
DESTRUCTIVE = "destructive"  # removes data
EXECUTE = "execute"          # runs processes
VCS = "vcs"                  # changes git history
LEVELS = (READ, WRITE, DESTRUCTIVE, EXECUTE, VCS)
