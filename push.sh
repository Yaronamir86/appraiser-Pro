#!/bin/bash
# ══════════════════════════════════════════════════
#  PUSH SCRIPT — אומדן פרו v7
#  Run this from any machine with git access to:
#  https://github.com/yaronamir86/appraiser-Pro
# ══════════════════════════════════════════════════

REPO_URL="https://github.com/yaronamir86/appraiser-Pro.git"
BRANCH="main"

echo "📁 Cloning repo..."
git clone $REPO_URL appraiser-push-temp
cd appraiser-push-temp

echo "📋 Copying updated files..."
# Copy from /mnt/user-data/outputs (Claude's output folder)
cp /mnt/user-data/outputs/form.html ./form.html
cp /mnt/user-data/outputs/register.html ./register.html
cp /mnt/user-data/outputs/saas-landing.html ./saas-landing.html
cp /mnt/user-data/outputs/billing.js ./billing.js

echo "📝 Staging changes..."
git add form.html register.html saas-landing.html billing.js

echo "✍️  Committing..."
git commit -m "v7 fixes: BOQ claim/kinon/shiput, material labels, insurance dates, arrangement plumber warning, Hebrew subtypes, rehab time clarity, billing core, SaaS landing"

echo "🚀 Pushing to GitHub..."
git push origin $BRANCH

echo "✅ Done! Live at: https://yaronamir86.github.io/appraiser-Pro/"
cd ..
rm -rf appraiser-push-temp
