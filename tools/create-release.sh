#!/bin/bash
# 快速创建 GitHub Release
# 用法: ./tools/create-release.sh [版本号]
# 示例: ./tools/create-release.sh 5.8.0
#
# 环境变量:
#   GITHUB_TOKEN - GitHub Personal Access Token (必须)
#
# 首次使用请设置: export GITHUB_TOKEN=ghp_xxxx

set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查 token
if [ -z "$GITHUB_TOKEN" ]; then
    echo -e "${RED}错误: 请设置 GITHUB_TOKEN 环境变量${NC}"
    echo "运行: export GITHUB_TOKEN=ghp_你的token"
    exit 1
fi

# 获取版本号
VERSION=${1:-}
if [ -z "$VERSION" ]; then
    # 从 package.json 读取
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null)
    if [ -z "$VERSION" ]; then
        echo -e "${RED}错误: 请提供版本号或确保 package.json 存在${NC}"
        echo "用法: $0 [版本号]"
        exit 1
    fi
    echo -e "${YELLOW}使用 package.json 中的版本: v${VERSION}${NC}"
fi

TAG="v$VERSION"
REPO="name-xxl/AcFun-Web-IP"

echo -e "${YELLOW}正在创建 Release: $TAG${NC}"

# 创建 Release
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases" \
    -d "{
        \"tag_name\": \"$TAG\",
        \"name\": \"v$VERSION\",
        \"body\": \"AcFun IP 属地显示脚本 v$VERSION\\n\\n## 安装\\n1. 安装 Tampermonkey 浏览器扩展\\n2. 点击 [acfun-reveal.user.js](https://github.com/$REPO/releases/download/$TAG/acfun-reveal.user.js) 自动安装\\n\\n## 更新内容\\n- 见 commit 历史\",
        \"draft\": false,
        \"prerelease\": false
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "201" ]; then
    URL=$(echo "$BODY" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8')).html_url" 2>/dev/null)
    echo -e "${GREEN}✓ Release 创建成功!${NC}"
    echo "链接: $URL"
else
    echo -e "${RED}✗ 创建失败 (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | node -p "try{JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8')).message}catch(e){require('fs').readFileSync('/dev/stdin', 'utf8')}" 2>/dev/null
    exit 1
fi
