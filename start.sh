#!/usr/bin/env bash
# سكربلو - تشغيل اللعبة
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "⬇️  جاري تثبيت الحزم..."
  npm install
fi
echo "🖌️  اللعبة تعمل على: http://localhost:3000"
node server.js
