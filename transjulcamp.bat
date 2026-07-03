@echo off
title Transjulcamp Server
echo ====================================================
echo   Iniciando Servidor Transjulcamp...
echo   Conectando a base de datos Supabase en la nube...
echo ====================================================
echo.
start "" http://127.0.0.1:8000
py -m uvicorn backend.main:app --port 8000
pause
