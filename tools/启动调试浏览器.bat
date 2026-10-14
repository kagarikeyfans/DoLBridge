@echo off
chcp 936 >nul
setlocal
title DoLBridge 调试浏览器启动器

rem 用法：把本脚本放到游戏目录里双击；也可以拖一个 html 到本脚本上。
rem 换端口：启动调试浏览器.bat "" 9333

set PORT=%~2
if "%PORT%"=="" set PORT=9222
set LOG=%TEMP%\dolbridge-launch.log
echo [%date% %time%] ---- 启动器开始 端口=%PORT% ---- >> "%LOG%"

rem ---------- 1. 找游戏本体 ----------
set GAME=%~1
if not defined GAME if exist "%~dp0Degrees of Lewdity.html" set "GAME=%~dp0Degrees of Lewdity.html"
if not defined GAME for %%F in ("%~dp0*Lewdity*.html") do if not defined GAME set "GAME=%%~fF"
if not defined GAME if exist "%~dp0..\Degrees of Lewdity.html" set "GAME=%~dp0..\Degrees of Lewdity.html"
if not defined GAME for %%F in ("%~dp0..\*Lewdity*.html") do if not defined GAME set "GAME=%%~fF"
if not defined GAME goto :nogame

rem ---------- 2. 找浏览器 ----------
set BROWSER=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER goto :nobrowser

rem ---------- 3. 端口检查 ----------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 goto :already

rem ---------- 4. 判断能否用玩家自己的配置 ----------
set DECIDE=SAME
for /f "delims=" %%v in ('powershell -NoProfile -Command "$p=(Get-Item -LiteralPath '%BROWSER%' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion; if($p){ $m=[int]($p -split '\.')[0]; if($m -ge 136){'SEP'} else {'SAME'} } else {'SAME'}"') do set "DECIDE=%%v"

echo.
echo   游戏  ：%GAME%
echo   端口  ：%PORT%
echo   浏览器：%BROWSER%
echo.

if /i "%DECIDE%"=="SEP" goto :launchsep

rem ---- 用你自己的 Chrome 配置（登录 / 书签 / 扩展都在）----
tasklist /fi "imagename eq chrome.exe" 2>nul | find /i "chrome.exe" >nul
if not errorlevel 1 goto :chromerunning

echo   将用**你自己的 Chrome 配置**打开（登录、书签都在）。
echo.
echo [%date% %time%] 启动(自己的配置) 端口=%PORT% >> "%LOG%"
start "" "%BROWSER%" --remote-debugging-port=%PORT% --no-first-run --no-default-browser-check "%GAME%"
goto :started

:launchsep
set PROFILE=%TEMP%\dol-debug-%PORT%
echo   你的 Chrome 是 136 或更新版本，不允许在默认配置上开调试端口。
echo   因此改用独立配置目录：%PROFILE%
echo   这个窗口里没有你的登录和书签，属于正常现象。
echo.
echo [%date% %time%] 启动(独立配置) 端口=%PORT% >> "%LOG%"
start "" "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%GAME%"
goto :started

:started
echo   已发出启动命令，几秒后会出现浏览器窗口。
echo   接着在游戏里装好 DoLBridge.mod.zip 并刷新页面。
echo.
pause
exit /b 0

:chromerunning
echo   检测到 Chrome 正在运行。
echo   请先**完全关闭 Chrome**（所有窗口，包括后台）再运行本脚本 ——
echo   否则新窗口会并入已有进程，调试端口不会生效。
echo.
echo [%date% %time%] Chrome 已在运行，未启动 >> "%LOG%"
echo.
pause
exit /b 1

:nogame
echo.
echo   没有找到游戏本体 html。
echo   请把本脚本放到游戏目录里再双击，或把 Degrees of Lewdity.html 拖到本脚本上。
echo [%date% %time%] 找不到游戏 html >> "%LOG%"
echo.
pause
exit /b 1

:nobrowser
echo.
echo   没有找到 Chrome 或 Edge，请先安装其中一个。
echo [%date% %time%] 找不到浏览器 >> "%LOG%"
echo.
pause
exit /b 1

:already
echo.
echo   端口 %PORT% 已经在监听，说明上一次的调试浏览器还开着。
echo   直接用那个窗口就行；要重新启动，请先把它完全关掉。
echo [%date% %time%] 端口 %PORT% 已被占用 >> "%LOG%"
echo.
pause
exit /b 0
