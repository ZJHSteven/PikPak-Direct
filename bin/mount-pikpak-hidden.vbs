' PikPak WebDAV 隐藏挂载启动器。
'
' 背景：
' Windows 11 若把 Windows Terminal 设为默认终端宿主，计划任务直接启动
' rclone.exe 这类控制台程序时，可能长期留下一个空白 Windows Terminal 窗口。
' rclone 自身的 --no-console 可以隐藏其控制台，但在“计划任务 -> 控制台程序”
' 这一启动链路里，终端宿主仍可能先被 Windows 拉起。
'
' 因此这里使用 WScript（GUI 子系统）作为最外层启动器：
' 1. WScript 本身不会创建控制台窗口；
' 2. Run 的窗口样式设为 0（隐藏）；
' 3. rclone 仍保留 --no-console，作为第二层保险；
' 4. 第三个参数 True 表示等待 rclone 退出，这样计划任务的 Running 状态
'    能真实反映挂载进程是否还活着，而不是启动后立刻显示 Ready。

Option Explicit

Dim shell
Dim command

Set shell = CreateObject("WScript.Shell")

' 使用 Chr(34) 生成双引号，避免 VBS 字符串里堆叠大量转义符。
' 只有确实可能包含空格的路径参数才显式加引号。
command = Chr(34) & _
    "C:\Users\ZJHSteven\AppData\Local\Microsoft\WinGet\Packages\Rclone.Rclone_Microsoft.Winget.Source_8wekyb3d8bbwe\rclone-v1.75.0-windows-amd64\rclone.exe" & _
    Chr(34) & _
    " mount PikPak: P:" & _
    " --vfs-cache-mode writes" & _
    " --cache-dir " & Chr(34) & "C:\Users\ZJHSteven\AppData\Local\rclone\vfs\PikPak" & Chr(34) & _
    " --vfs-cache-max-size 20G" & _
    " --vfs-cache-min-free-space 20G" & _
    " --vfs-cache-max-age 24h" & _
    " --dir-cache-time 10m" & _
    " --poll-interval 0" & _
    " --volname PikPak" & _
    " --network-mode" & _
    " --log-file " & Chr(34) & "C:\Users\ZJHSteven\AppData\Local\rclone\pikpak-mount.log" & Chr(34) & _
    " --log-level INFO" & _
    " --no-console"

' windowStyle=0：隐藏窗口。
' waitOnReturn=True：等待 rclone 退出并把退出码传给计划任务。
WScript.Quit shell.Run(command, 0, True)

