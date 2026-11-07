# How to Use

## Prerequisites:

@gambar(1794052370313.png)

1. Snapgent MCP is already running (.exe for Windows, snapgent for Linux)

@gambar(1794047217661.png, width=200)

## Quickstart

@gambar(1794052351628.png, width=200) @gambar(1794052578579.png, width=200)

Open a new chat in any provider, then click the start button.

Auto mode does not ask for permission when performing actions.

snapgent-connector, the working folder. It is better to pick a folder than Auto.

Snapgent MCP and Deepseek can be ignored.

The terminal is for running tools manually and for monitoring the output of tools that have run or are running.

The star is for skills (you can add/import skills).

Settings is for configuration and tests.

Info is for the tutorial.

Once started there is a chat icon; there MCP is set to not execute anything, good for those who prefer working manually and want to save limits and avoid suspension.

Stable providers: Deepseek, Claude, Meta

Good enough providers: z.ai (GLM), Kimi, Grok.

Note: GLM sometimes calls its internal tools (this just adds working time :D), Kimi and Grok are sometimes overloaded, Deepseek sometimes fails and needs a continue (but Deepseek is worth it).

Suggestion: rotate providers after finishing each feature; Deepseek is prone to 3-7 day suspensions.

## Terminal

@gambar(1794050398858.png, width=50)

opens the terminal popup; here the results of commands that have been run appear for monitoring, and you can also run a command manually or copy the output of each command. For example commands you can run, see Examples.

@gambar(1794049484007.png)

## File / Folder

@gambar(1794050421709.png, width=50)

opens the Files popup; files and folders can be selected and inserted into the chat context. The refresh button reloads the files/folders when there are updates that are not shown yet. Then there is the Open this list... checkbox: its use is that when you type @ in the AI chat box a list appears like in the picture. IMPORTANT: when a folder is selected, every file inside that folder is sent.

@gambar(1794049937101.png)

@gambar(1794050042742.png)

## Skill

@gambar(1794050432724.png, width=50)

@gambar(1794050252927.png, width=300)

keep in mind that this skill is only injected, saying that a skill is enabled in the workspace, and the AI will ask whether the skill needs to be used or not.

## MCP

@gambar(1794050380299.png, width=50)

@gambar(1794050474844.png, width=300)

not very useful yet (ignore)

## Preferences

@gambar(1794050594549.png, width=50)

@gambar(1794051092428.png, width=500) @gambar(1794050620912.png, width=500)

@gambar(1794050631972.png, width=500)

Message size, by default already set to 50K, meaning each prompt is limited to 50K characters. If it is more, there are 2 conditions: when Output as file is active all output is sent as an attached .txt file (here it can even reach 1100K characters, roughly 275k tokens/context, which is quite big). Suggestion: leave the default.

Commands per reply means that per AI answer, if it needs to use all MCP tools, the limit is 20 tool JSON calls that can be executed.

Output as file: when active, if the prompt produced by MCP exceeds Message size it is sent as an attached .txt file. (providers that can receive files include Deepseek, ChatGPT - it hits the file upload limit too quickly, Claude, Meta AI, z.ai, Kimi, and Grok)

Only for this site: when active the settings are saved for that provider site; when not active they are saved for all sites.

Folders left out of attachments: this part relates to File/Folder; if a folder/file is added it will not appear in the file list (the point is so the list does not fill up with junk from node_modules, target, etc.).

Project instruction files: this part is the reference md file, usually used as rules in a project so the AI can obey those rules. It works by injecting the md file at the start when a chat session begins.

Move to the top right corner, moves the popup menu position to the top right corner.

Hide the bar, hides the popup (also possible from the lightning icon)

@gambar(1794051319093.png, width=50)

Calibrate this site, to calibrate a provider (for example an AI provider that is not supported yet); you will be asked to pick the textfield, the send button (you can use enter if the textfield has no send button), the AI response, and the user chat. Additionally, in some providers the AI response is in the same part as the thinking (this can be considered a tool call by MCP), so it is recommended to pick the thinking part if, when picking the AI response part, the thinking area comes along.

Export calibration, exports a json file for one AI provider's calibration.

Copy diagnostics, for debugging needs, just ignore it.

Remove calibration, deletes the calibration result (if deleted it needs to be calibrated again manually)

Export all calibrations, exports a json file for all providers, including the profile from message size to project instruction files

Import calibrations, imports a json file to overwrite the default calibrations if you have configured your own.

the rest is only for testing

## Mode Agent Off

@gambar(1794051654540.png, width=50)

In this part MCP will not read the output the AI gives, good if you want to run the commands manually via the terminal yourself and send the output as needed (this can save limits and avoid bots/suspension because an automatic process is too fast).

## Action Buttons

@gambar(1794051849382.png, width=50) @gambar(1794051874950.png, width=50)

The Play button can be used when you stop a process that is running. For example MCP is executing 3 commands, at process 1/3 you press the yellow stop button, then the Play button can continue it.

## Dropdown Auto

@gambar(1794051992617.png, width=300)

@gambar(1794052201818.png, width=200) @gambar(1794052027483.png, width=200)

there are 3 modes: Plan, Auto or Manual. Plan may only read files, MCP will definitely refuse edits; Auto without user approval; and Manual always asks for approval for every action.

## Dropdown Workspace

@gambar(1794052000319.png, width=300)

@gambar(1794052210359.png, width=200) @gambar(1794052008606.png, width=200)

is the working folder/workspace that is selected. By default Auto takes it from the code editors vscode, antigravity, codex, which are vscode-based. It is recommended to pick a folder manually before starting a new chat session.

## Dropdown MCP

@gambar(1794052137314.png, width=300)

@gambar(1794052217143.png, width=200) @gambar(1794052144153.png, width=200)

not very important, by default it picks the MCP already running in Prerequisites 1.

## Dropdown Provider

@gambar(1794052158468.png, width=300)

@gambar(1794052220202.png, width=200) @gambar(1794052232818.png, width=200)

the AI provider active on the page currently open. If selected it will open a new tab. Just a shortcut.

## Multiple Account

@gambar(1794061821278.png, width=300)

multiple account only work on Deepsek and Claude provider.

Save to store the current login session (required to fill Name this login... field).

Sign in with another account for adding account. then login with another account.

Switch to switch the session of selected account.
