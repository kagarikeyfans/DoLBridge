@echo off
chcp 936 >nul
setlocal
title DoLBridge 调试浏览器启动器

rem 用法：把本脚本放到游戏目录里双击；也可以拖一个 html 到本脚本上。
rem 换端口：启动调试浏览器.bat "" 9333

set PORT=%~2
if "%PORT%"=="" set PORT=9222

set LOG=%TEMP%\dolbridge-launch.log
echo [%date% %time%] ---- 启动器开始 ---- >> "%LOG%"

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

rem ---------- 3. 配置目录：默认端口沿用原来的 dol-debug（存档在里面）----------
set PROFILE=%TEMP%\dol-debug-%PORT%
if "%PORT%"=="9222" set "PROFILE=%TEMP%\dol-debug"

rem ---------- 4. 端口检查 ----------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 goto :already

echo.
echo   游戏    ：%GAME%
echo   端口    ：%PORT%
echo   浏览器  ：%BROWSER%
echo   配置目录：%PROFILE%
echo.
echo   提示：浏览器存档 / mod 设置 / API Key 都跟着配置目录走，
echo         想接着玩原来的进度，就用默认端口 9222 启动。
echo.
echo [%date% %time%] 启动 端口=%PORT% >> "%LOG%"
echo [%date% %time%] 游戏=%GAME% >> "%LOG%"
echo [%date% %time%] 浏览器=%BROWSER% >> "%LOG%"
echo [%date% %time%] 配置目录=%PROFILE% >> "%LOG%"

start "" "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%GAME%"

echo   已发出启动命令，几秒后会出现浏览器窗口。
echo   接着在游戏里装好 DoLBridge.mod.zip 并刷新页面。
echo.
pause
exit /b 0

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
