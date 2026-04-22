# Session 单例与 Sidecar 复用机制 - 技术架构文档

> **版本**: 0.1.10
> **状态**: ✅ 已实现
> **作者**: Claude (Code Review)
> **更新日期**: 2026-02-04

## 一、核心概念

### 1.1 产品定义

| 概念 | 定义 | 说明 |
|------|------|------|
| **Sidecar = Agent 实例** | 一个 Sidecar 进程 = 一个 Claude Agent SDK 实例 | Sidecar 是运行 AI 对话的后端进程 |
| **Session:Sidecar = 1:1** | 每个 Session 最多有一个 Sidecar | 严格对应，即使同工作区不同 Session 也需独立 Sidecar |
| **后端优先，前端辅助** | Sidecar 可独立运行 | 定时任务场景下无需前端 Tab |
| **Owner 模型** | Tab 和 CronTask 是 Sidecar 的"使用者" | 不是"拥有者"，Sidecar 服务于 Session |

### 1.2 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │   Tab 1     │  │   Tab 2     │     ← 视图层 (可选)       │
│  │ session_123 │  │ session_456 │                           │
│  └──────┬──────┘  └──────┬──────┘                           │
│         │                │                                   │
├─────────┼────────────────┼───────────────────────────────────┤
│         │                │              Rust Layer           │
│         │                │                                   │
│   ┌─────┴────────────────┴─────┐   ┌─────────────────────┐  │
│   │     SidecarManager         │   │  session_activations │  │
│   │  sidecars HashMap          │   │  (Session 激活追踪)  │  │
│   │  Key = Session ID          │   └─────────────────────┘  │
│   └─────┬────────────────┬─────┘                            │
│         │                │                                   │
│         ▼                ▼                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Sidecar A   │  │ Sidecar B   │  │ Sidecar C   │         │
│  │ session_123 │  │ session_456 │  │ session_789 │         │
│  │ Owner: Tab1 │  │ Owner: Tab2 │  │ Owner: Cron │ ← 无 Tab │
│  │ :31415      │  │ :31416      │  │ :31417      │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、数据结构

### 2.1 Rust 层 (`src-tauri/src/sidecar.rs`)

```rust
/// Sidecar 使用者类型
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID
    Tab(String),
    /// Cron Task ID
    CronTask(String),
}

/// Session 级别的 Sidecar 实例
pub struct SessionSidecar {
    /// Bun 子进程句柄
    pub process: Child,
    /// 运行端口
    pub port: u16,
    /// 服务的 Session ID
    pub session_id: String,
    /// 工作区路径
    pub workspace_path: PathBuf,
    /// 健康状态
    pub healthy: bool,
    /// 所有使用者（Tab + CronTask）
    pub owners: HashSet<SidecarOwner>,
    /// 创建时间
    pub created_at: std::time::Instant,
}

/// Session 激活记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionActivation {
    pub session_id: String,
    pub tab_id: Option<String>,
    pub task_id: Option<String>,
    pub port: u16,
    pub workspace_path: String,
    pub is_cron_task: bool,
}

/// 多实例 Sidecar 管理器
pub struct SidecarManager {
    /// Session ID -> SessionSidecar (主存储)
    sidecars: HashMap<String, SessionSidecar>,

    /// Session ID -> SessionActivation (激活状态追踪)
    session_activations: HashMap<String, SessionActivation>,

    /// Tab ID -> SidecarInstance (遗留，仅 Global Sidecar 使用)
    instances: HashMap<String, SidecarInstance>,

    /// 端口计数器
    port_counter: AtomicU16,
}
```

### 2.2 核心 IPC 命令

| 命令 | 签名 | 说明 |
|------|------|------|
| `cmd_ensure_session_sidecar` | `(session_id, workspace, owner_type, owner_id) -> Result<SidecarResult>` | 确保 Session 有 Sidecar |
| `cmd_release_session_sidecar` | `(session_id, owner_type, owner_id) -> Result<bool>` | 释放 Owner 使用权 |
| `cmd_get_session_port` | `(session_id) -> Option<u16>` | 获取 Sidecar 端口 |
| `cmd_get_session_activation` | `(session_id) -> Option<SessionActivation>` | 查询激活状态 |
| `cmd_activate_session` | `(session_id, tab_id, task_id, port, workspace, is_cron)` | 激活 Session |
| `cmd_deactivate_session` | `(session_id)` | 取消激活 |
| `cmd_upgrade_session_id` | `(old_session_id, new_session_id) -> bool` | 升级 Session ID |

---

## 三、Session 切换场景

### 3.1 场景矩阵

| 场景 | 条件 | 行为 | 结果 |
|------|------|------|------|
| **场景 1** | 新 Tab + 新 Session | 创建新 Sidecar | 新 Tab 独占新 Sidecar |
| **场景 2** | 新 Tab + 其他 Tab 的 Session | 跳转到已有 Tab | 不创建新 Sidecar |
| **场景 3** | 同 Tab 切换到定时任务 Session | 连接已有 CronTask Sidecar | Tab 成为共享 Owner |
| **场景 4** | 同 Tab 切换到无人使用的 Session | Handover（资源复用）| HashMap key 更新 |

### 3.2 场景 4 详解：Handover 机制

当用户在同一 Tab 内切换到一个**无人使用的历史 Session** 时，采用 Handover 机制复用 Sidecar：

```
┌───────────────────────────────────────────────────────┐
│ 场景 4: 同 Tab 切换 Session (Handover)                │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Before:                                              │
│  ┌─────────────┐                                      │
│  │   Tab 1     │                                      │
│  │ session_A   │──────► sidecars["session_A"]         │
│  └─────────────┘        └── Owner: Tab(tab1)          │
│                                                       │
│  Action: 用户选择历史 session_B                        │
│                                                       │
│  After:                                               │
│  ┌─────────────┐                                      │
│  │   Tab 1     │                                      │
│  │ session_B   │──────► sidecars["session_B"]         │
│  └─────────────┘        └── Owner: Tab(tab1)          │
│                                                       │
│  操作步骤:                                             │
│  1. upgradeSessionId("session_A", "session_B")        │
│     - HashMap key 从 session_A 改为 session_B         │
│     - Sidecar 进程不重启                              │
│  2. deactivateSession("session_A")                    │
│  3. activateSession("session_B", tab1, port, ...)     │
│  4. POST /chat/switch-session 通知后端切换            │
│                                                       │
│  资源复用: Sidecar 进程复用，无需重启                  │
└───────────────────────────────────────────────────────┘
```

**关键代码** (`App.tsx`):

```typescript
// Scenario 4: Normal switch → Hand over Sidecar to new Session
if (oldSessionId) {
    // 1. Move sidecars HashMap entry: sidecars[oldSessionId] → sidecars[newSessionId]
    const upgraded = await upgradeSessionId(oldSessionId, sessionId);

    if (upgraded) {
        // 2. Update session_activations
        await deactivateSession(oldSessionId);
        const port = await getSessionPort(sessionId);
        if (port !== null) {
            await activateSession(sessionId, tabId, null, port, currentTab.agentDir, false);
        }
    } else {
        // Upgrade failed - create new Sidecar
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
        await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
    }
}
```

---

## 四、Owner 生命周期管理

### 4.1 Owner 添加

```
┌──────────────────────────────────────────────────────────────────┐
│ Owner 添加流程                                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ensureSessionSidecar(sessionId, workspace, ownerType, ownerId)  │
│                    │                                             │
│                    ▼                                             │
│       ┌─────────────────────────────────┐                        │
│       │ sidecars.get(sessionId) 存在?   │                        │
│       └──────────────┬──────────────────┘                        │
│                      │                                           │
│           ┌──────────┴──────────┐                                │
│           │ Yes                 │ No                             │
│           ▼                     ▼                                │
│    ┌─────────────┐     ┌─────────────────────┐                   │
│    │ 添加 Owner  │     │ 创建新 Sidecar       │                   │
│    │ 返回端口    │     │ 添加 Owner           │                   │
│    └─────────────┘     │ 等待健康检查         │                   │
│                        │ 返回端口             │                   │
│                        └─────────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Owner 释放

```
┌──────────────────────────────────────────────────────────────────┐
│ Owner 释放流程                                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  releaseSessionSidecar(sessionId, ownerType, ownerId)            │
│                    │                                             │
│                    ▼                                             │
│       ┌─────────────────────────────────┐                        │
│       │ 从 owners HashSet 移除 Owner    │                        │
│       └──────────────┬──────────────────┘                        │
│                      │                                           │
│           ┌──────────┴──────────┐                                │
│           │ owners.is_empty()?  │                                │
│           │                     │                                │
│           │ Yes                 │ No                             │
│           ▼                     ▼                                │
│    ┌─────────────────┐   ┌─────────────┐                         │
│    │ 停止 Sidecar    │   │ 保持运行    │                         │
│    │ (Drop kills)    │   │ 其他 Owner  │                         │
│    │ 返回 true       │   │ 返回 false  │                         │
│    └─────────────────┘   └─────────────┘                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 五、定时任务执行

### 5.1 执行流程

```
┌──────────────────────────────────────────────────────────────────┐
│ 定时任务执行 (后端优先模式)                                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Rust Scheduler                                                  │
│       │                                                          │
│       ├── 1. 检查 Session 是否已有 Sidecar                        │
│       │       └── Yes → 复用已有 Sidecar                          │
│       │       └── No  → 启动无头 Sidecar                          │
│       │                                                          │
│       ├── 2. ensureSessionSidecar(sessionId, 'cron', taskId)     │
│       │                                                          │
│       ├── 3. HTTP POST /cron/execute (reqwest)                   │
│       │       └── 直接调用 Sidecar，不依赖前端 Tab                 │
│       │                                                          │
│       ├── 4. 处理执行结果                                         │
│       │       ├── 记录执行历史                                    │
│       │       ├── 检查 AI 退出请求                                │
│       │       └── 发送系统通知                                    │
│       │                                                          │
│       └── 5. 定时任务完成后释放 Owner                              │
│               └── releaseSessionSidecar(sessionId, 'cron', taskId)│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 无头 Sidecar 场景

当用户关闭所有 Tab 但定时任务仍在运行时：

```
┌───────────────────────────────────────────────────────┐
│ 无头 Sidecar 运行                                      │
├───────────────────────────────────────────────────────┤
│                                                       │
│  sidecars["session_789"]                              │
│       ├── port: 31417                                 │
│       ├── owners: { CronTask("task_001") }            │
│       └── 状态: 运行中                                 │
│                                                       │
│  前端: 无 Tab 连接                                     │
│  后端: 正常接收定时任务执行请求                         │
│                                                       │
│  当用户打开 Tab 连接此 Session 时:                     │
│  - 不创建新 Sidecar                                   │
│  - Tab 成为额外 Owner                                 │
│  - owners: { CronTask("task_001"), Tab("tab_1") }     │
│                                                       │
└───────────────────────────────────────────────────────┘
```

---

## 六、历史 Session 访问

### 6.1 SessionHistoryDropdown 检查流程

```typescript
const handleSelectSession = async (sessionId: string) => {
    // 1. 检查 Session 激活状态
    const activation = await getSessionActivation(sessionId);

    if (activation?.tabId) {
        // 场景 2: 已在另一个 Tab 打开 → 跳转
        dispatch('pm-copilot:focus-tab', { tabId: activation.tabId });
        return;
    }

    if (activation && !activation.tabId) {
        // 场景 3: 被无头 Sidecar 使用 (定时任务) → 连接
        dispatch('pm-copilot:connect-to-sidecar', {
            sessionId,
            port: activation.port,
            workspacePath: activation.workspacePath,
        });
        return;
    }

    // 场景 4: 无人使用 → 正常加载 (触发 Handover)
    onSelectSession(sessionId);
};
```

---

## 七、应用重启恢复

### 7.1 恢复流程

```
┌──────────────────────────────────────────────────────────────────┐
│ 应用重启后定时任务恢复                                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. App 启动                                                     │
│       │                                                          │
│       ├── cleanup_stale_sidecars()  // 清理残留进程               │
│       │                                                          │
│       ├── CronTaskManager.restore_running_tasks()                │
│       │       │                                                  │
│       │       └── 遍历 status=running 的任务                      │
│       │               │                                          │
│       │               ├── ensureSessionSidecar(sessionId, 'cron')│
│       │               │       启动新 Sidecar                      │
│       │               │                                          │
│       │               └── reschedule_next_execution()            │
│       │                       计算下次执行时间                    │
│       │                                                          │
│       └── 前端无需参与恢复                                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 八、验证清单

- [x] 打开已在其他 Tab 打开的 Session → 跳转到已有 Tab
- [x] 打开定时任务正在使用的 Session → 新建 Tab 连接到已有 Sidecar
- [x] 关闭 Tab（有其他使用者）→ Sidecar 继续运行
- [x] 关闭 Tab（无其他使用者）→ Sidecar 停止
- [x] 定时任务执行（无 Tab）→ Rust 直接 HTTP 调用
- [x] 应用重启 → 定时任务自动恢复，无需前端参与
- [x] 同 Tab 切换 Session → Handover 机制复用 Sidecar
- [x] Handover 后 HashMap key 正确更新

---

## 九、相关文档

- [architecture.md](./architecture.md) - 整体技术架构
- [session_state_sync.md](./session_state_sync.md) - SSE 状态同步机制
- [session_storage.md](./session_storage.md) - Session 存储格式
