' PikPak WebDAV hidden mount launcher.
' Keep this VBS file ASCII-only because the legacy Windows Script Host parser
' can misread UTF-8 source files without a BOM. Detailed Chinese rationale is
' documented in PROGRESS.md and PLANS.md.
'
' WScript is a GUI-subsystem host, so it does not create a console window.
' Run(..., 0, True) starts rclone hidden and waits for it to exit. Waiting is
' intentional: Task Scheduler then keeps the task in Running state for as long
' as the mount process is alive.

Option Explicit

Dim shell
Dim command

Set shell = CreateObject("WScript.Shell")

' None of the paths below contain spaces, so the command deliberately avoids
' nested quoting. This makes the launcher much harder to break accidentally.
command = "C:\Users\ZJHSteven\AppData\Local\Microsoft\WinGet\Packages\Rclone.Rclone_Microsoft.Winget.Source_8wekyb3d8bbwe\rclone-v1.75.0-windows-amd64\rclone.exe" & _
    " mount PikPak: P:" & _
    " --vfs-cache-mode writes" & _
    " --cache-dir C:\Users\ZJHSteven\AppData\Local\rclone\vfs\PikPak" & _
    " --vfs-cache-max-size 20G" & _
    " --vfs-cache-min-free-space 20G" & _
    " --vfs-cache-max-age 24h" & _
    " --dir-cache-time 10m" & _
    " --poll-interval 0" & _
    " --volname PikPak" & _
    " --network-mode" & _
    " --log-file C:\Users\ZJHSteven\AppData\Local\rclone\pikpak-mount.log" & _
    " --log-level INFO" & _
    " --no-console"

WScript.Quit shell.Run(command, 0, True)

