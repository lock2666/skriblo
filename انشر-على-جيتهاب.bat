@echo off
chcp 65001 >nul
title سكربلو - الرفع على GitHub

set GIT=C:\Users\R\Desktop\abood\.tools\git\cmd\git.exe
cd /d "%~dp0"

echo ============================================
echo    رفع لعبة سكربلو على GitHub
echo ============================================
echo.
set /p USER=اكتب اسم مستخدم GitHub الخاص بك: 
if "%USER%"=="" (echo لم تكتب الاسم! & pause & exit /b 1)

echo.
echo [1/3] سأفتح لك صفحة انشاء المستودع في المتصفح...
echo       - الاسم: skriblo
echo       - اجعله Public
echo       - لا تضف README ولا gitignore ^(موجودان عندك فعلاً^)
echo       - اضغط Create repository
start https://github.com/new?name=skriblo
pause

echo.
echo [2/3] ربط المستودع المحلي بـ GitHub...
"%GIT%" remote remove origin 2>nul
"%GIT%" remote add origin https://github.com/%USER%/skriblo.git

echo.
echo [3/3] جاري الرفع...
"%GIT%" branch -M main
"%GIT%" push -u origin main
if errorlevel 1 (
  echo.
  echo ============================================
  echo  فشل الرفع!
  echo  اذا طلب منك كلمة المرور فاستخدم Personal Access Token
  echo  بدلاً منها:  https://github.com/settings/tokens
  echo  ^(اختر صلاحية repo فقط^)
  echo ============================================
  pause
  exit /b 1
)

echo.
echo ============================================
echo   تم الرفع بنجاح!
echo   المستودع: https://github.com/%USER%/skriblo
echo.
echo   الخطوة التالية: Settings -^> Pages -^> Source: GitHub Actions
echo ============================================
pause
