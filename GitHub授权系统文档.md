# Open SWE GitHub 授权系统技术文档

## 概述

Open SWE 的 GitHub 授权系统采用 OAuth 2.0 + GitHub App 的双重认证模式，为用户提供安全可靠的 GitHub 集成功能。系统支持用户身份认证和应用级别的权限管理。

## 架构设计

### 认证流程图

```
用户 → GitHub OAuth → 获取 Access Token → GitHub App 安装 → 仓库访问权限
```

### 核心组件

1. **OAuth 2.0 认证流程**
2. **GitHub App 集成管理**
3. **安全 Cookie 管理**
4. **中间件路由保护**
5. **前端状态管理**

## API 接口详细说明

### 1. 认证相关接口

#### 1.1 GitHub OAuth 登录

**接口地址**: `GET /api/auth/github/login`

**功能**: 启动 GitHub OAuth 授权流程

**实现文件**: `/apps/web/src/app/api/auth/github/login/route.ts`

**流程**:
1. 生成随机 state 参数防止 CSRF 攻击
2. 构建 GitHub OAuth 授权 URL
3. 将 state 存储在 HTTP-only cookie 中
4. 重定向到 GitHub 授权页面

**环境变量**:
- `NEXT_PUBLIC_GITHUB_APP_CLIENT_ID`: GitHub App 客户端 ID
- `GITHUB_APP_REDIRECT_URI`: OAuth 回调地址

**Cookie 设置**:
- `github_auth_state`: 存储 state 参数，10分钟过期

#### 1.2 GitHub OAuth 回调

**接口地址**: `GET /api/auth/github/callback`

**功能**: 处理 GitHub OAuth 授权回调

**实现文件**: `/apps/web/src/app/api/auth/github/callback/route.ts`

**查询参数**:
- `code`: GitHub 返回的授权码
- `state`: 状态参数，用于 CSRF 验证
- `error`: 错误信息（可选）
- `installation_id`: GitHub App 安装 ID（可选）

**流程**:
1. 验证 state 参数防止 CSRF 攻击
2. 使用授权码换取 access token
3. 将 token 信息存储在安全 cookies 中
4. 重定向到 `/chat` 页面

**Cookie 设置**:
- `github_token`: Access token，30天过期，HTTP-only
- `github_token_type`: Token 类型，30天过期，HTTP-only
- `github_installation_id`: 安装 ID，30天过期

#### 1.3 用户认证状态

**接口地址**: `GET /api/auth/status`

**功能**: 检查用户当前认证状态

**实现文件**: `/apps/web/src/app/api/auth/status/route.ts`

#### 1.4 用户信息

**接口地址**: `GET /api/auth/user`

**功能**: 获取当前认证用户信息

**实现文件**: `/apps/web/src/app/api/auth/user/route.ts`

#### 1.5 登出

**接口地址**: `POST /api/auth/logout`

**功能**: 清除用户认证信息

**实现文件**: `/apps/web/src/app/api/auth/logout/route.ts`

### 2. GitHub App 相关接口

#### 2.1 GitHub App 安装

**接口地址**: `GET /api/github/installation`

**功能**: 重定向到 GitHub App 安装页面

**实现文件**: `/apps/web/src/app/api/github/installation/route.ts`

#### 2.2 GitHub App 安装回调

**接口地址**: `GET /api/github/installation-callback`

**功能**: 处理 GitHub App 安装完成后的回调

**实现文件**: `/apps/web/src/app/api/github/installation-callback/route.ts`

**查询参数**:
- `installation_id`: GitHub App 安装 ID
- `custom_state`: 自定义状态参数

**Cookie 管理**:
- `installation_return_to`: 安装完成后的返回地址
- `github_installation_state`: 安装状态验证

#### 2.3 获取安装列表

**接口地址**: `GET /api/github/installations`

**功能**: 获取用户的所有 GitHub App 安装

**实现文件**: `/apps/web/src/app/api/github/installations/route.ts`

**响应格式**:
```json
{
  "installations": [
    {
      "id": 12345,
      "account": {
        "login": "username",
        "avatar_url": "https://...",
        "type": "User"
      },
      "target_type": "User"
    }
  ]
}
```

#### 2.4 切换安装

**接口地址**: `POST /api/github/switch-installation`

**功能**: 切换当前使用的 GitHub App 安装

**实现文件**: `/apps/web/src/app/api/github/switch-installation/route.ts`

**请求体**:
```json
{
  "installationId": "12345"
}
```

#### 2.5 获取仓库列表

**接口地址**: `GET /api/github/repositories`

**功能**: 获取当前安装下的仓库列表

**实现文件**: `/apps/web/src/app/api/github/repositories/route.ts`

**查询参数**:
- `page`: 页码（可选）
- `per_page`: 每页数量（可选）

#### 2.6 GitHub Token 信息

**接口地址**: `GET /api/github/token`

**功能**: 获取当前 GitHub token 信息

**实现文件**: `/apps/web/src/app/api/github/token/route.ts`

#### 2.7 GitHub API 代理

**接口地址**: `GET/POST /api/github/proxy/[...path]`

**功能**: 代理 GitHub API 请求，自动添加认证头

**实现文件**: `/apps/web/src/app/api/github/proxy/[...path]/route.ts`

## 安全机制

### 1. CSRF 保护

- 使用随机生成的 `state` 参数
- 在 OAuth 流程中验证 state 一致性
- 防止跨站请求伪造攻击

### 2. Cookie 安全

**安全配置**:
```typescript
{
  httpOnly: true,           // 防止 XSS 攻击
  secure: true,            // 生产环境使用 HTTPS
  sameSite: "lax",         // 防止 CSRF
  maxAge: 60 * 60 * 24 * 30, // 30天过期
  path: "/"
}
```

### 3. 中间件保护

**实现文件**: `/apps/web/src/middleware.ts`

**保护路由**:
- `/chat/*`: 需要认证才能访问
- `/`: 已认证用户自动重定向到 `/chat`

**验证逻辑**:
1. 检查 GitHub token 存在性
2. 验证 installation ID
3. 调用 `verifyGithubUser` 验证 token 有效性

### 4. Token 管理

**实现文件**: `/apps/web/src/lib/auth.ts`

**核心函数**:
- `storeGitHubToken()`: 安全存储 token
- `getGitHubToken()`: 获取 token 信息
- `clearGitHubToken()`: 清除 token
- `isAuthenticated()`: 检查认证状态

## 前端集成

### 1. 状态管理

#### GitHub App Provider

**实现文件**: `/apps/web/src/providers/GitHubApp.tsx`

**功能**: 提供全局 GitHub 状态管理

#### useGitHubApp Hook

**实现文件**: `/apps/web/src/hooks/useGitHubApp.ts`

**主要功能**:
- 安装状态管理
- 仓库列表获取
- 分支管理
- 仓库选择

#### useGitHubInstallations Hook

**实现文件**: `/apps/web/src/hooks/useGitHubInstallations.ts`

**主要功能**:
- 获取安装列表
- 切换安装
- 安装状态管理

### 2. UI 组件

#### GitHub 管理器

**实现文件**: `/apps/web/src/features/settings-page/github-manager.tsx`

**功能**:
- GitHub 登录界面
- 安装管理
- 仓库列表显示
- 权限状态展示

#### 安装选择器

**实现文件**: `/apps/web/src/components/github/installation-selector.tsx`

**功能**:
- 安装下拉选择
- 安装状态显示
- 错误处理

## 环境变量配置

### 必需环境变量

```env
# GitHub App 配置
NEXT_PUBLIC_GITHUB_APP_CLIENT_ID=your_github_app_client_id
GITHUB_APP_CLIENT_SECRET=your_github_app_client_secret
GITHUB_APP_REDIRECT_URI=http://localhost:3000/api/auth/github/callback

# 应用配置
NODE_ENV=development|production
```

### 可选环境变量

```env
# GitHub App 安装回调
GITHUB_INSTALLATION_CALLBACK_URL=http://localhost:3000/api/github/installation-callback
```

## 错误处理

### 常见错误类型

1. **认证错误**
   - `GitHub access token not found`
   - `Please authenticate first`
   - `Invalid state parameter`

2. **配置错误**
   - `GitHub App configuration missing`
   - `Configuration missing`

3. **API 错误**
   - `Token exchange failed`
   - `Installation callback failed`

### 错误处理策略

1. **前端错误处理**
   - 显示用户友好的错误信息
   - 提供重试机制
   - 自动重定向到登录页面

2. **后端错误处理**
   - 详细的错误日志记录
   - 安全的错误信息返回
   - 自动清理无效 cookies

## 部署注意事项

### 1. GitHub App 配置

1. 在 GitHub 创建 GitHub App
2. 配置正确的回调 URL
3. 设置必要的权限范围
4. 获取 Client ID 和 Client Secret

### 2. 域名配置

- 确保回调 URL 与部署域名一致
- 配置正确的 CORS 策略
- 使用 HTTPS（生产环境）

### 3. 安全配置

- 启用 secure cookies（生产环境）
- 配置正确的 CSP 策略
- 定期轮换 Client Secret

## 调试指南

### 1. 常见问题排查

1. **OAuth 回调失败**
   - 检查回调 URL 配置
   - 验证 Client ID 和 Secret
   - 查看浏览器网络请求

2. **安装回调失败**
   - 检查 GitHub App 权限配置
   - 验证安装回调 URL
   - 查看服务器日志

3. **Token 验证失败**
   - 检查 token 是否过期
   - 验证 GitHub API 权限
   - 查看中间件日志



