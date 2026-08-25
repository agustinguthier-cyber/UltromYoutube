@echo off
cd /d "%~dp0"
echo ===============================================
echo   UltromYoutube
echo ===============================================
echo.
echo Iniciando el servidor... dejá esta ventana ABIERTA
echo mientras uses la app (cerrarla apaga el servidor).
echo.
echo   En esta PC:              http://localhost:3000
echo   Desde el celular (misma Wi-Fi): http://172.18.108.53:3000
echo.
echo (Si el celular no carga, revisá que la Wi-Fi esté
echo  marcada como red Privada y que el firewall permita
echo  el puerto 3000 - ver CLAUDE.md o preguntame de nuevo.)
echo.
node server.js
echo.
echo El servidor se detuvo. Si fue un error, el detalle
echo debería verse arriba.
pause
