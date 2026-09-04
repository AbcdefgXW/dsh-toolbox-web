/**
 * client.js — dsh-toolbox 前端（浏览器端）
 *
 * 手写 client（无构建管线），遵循 dsh 客户端插件约定：
 * - window.__ModuleLoader__.load({id, factory})
 * - 调用后端：ctx.remote.$mount({package, descriptors}) → ctx.remote.<namespace>.<method>(...)
 * - 设置分组：ctx.slots.register({name: "settings.section", id, order, label, component})
 * - 设置数据：ctx.settingsScope.bind({namespace}) → getSnapshot()/set(field, value)
 *
 * 注意：浏览器直接加载，不能用 JSX 语法——用 react/jsx-runtime 的 jsx()。
 */
window.__ModuleLoader__.load({
  id: "dsh-toolbox-web",
  factory: (require) => {
    const { jsx } = require("react/jsx-runtime");
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const TOOLS_NS = "dsh-toolbox";

    /** strict codec：前端只校验 mode === "strict"；schema.parse 运行时透传任意值。 */
    const anySchema = { parse: (v) => v };
    const strictCodec = (typeSymbol) => ({ mode: "strict", typeSymbol, schema: anySchema });

    /** 与后端一致的端点声明（用于 $mount 生成前端调用方法）。 */
    const DESCRIPTORS = [
      ["info", []],
      ["sessions.list", []],
      ["sessions.header", ["sessionId"]],
      ["sessions.delete", ["sessionId"]],
      ["sessions.clearEmpty", []],
      ["sessions.copy", ["sessionId"]],
      ["sessions.resetCwd", ["sessionId"]],
      ["sessions.move", ["targetCwd", "sessionId"]],
      ["sessions.detach", ["sessionId"]],
      ["workspace.list", []],
      ["workspace.create", ["name"]],
      ["workspace.rename", ["oldName", "newName"]],
      ["workspace.moveSessions", ["name", "targetCwd"]],
      ["workspace.delete", ["name", "sessionsAction"]],
      ["workspace.copy", ["name"]],
      ["search.query", ["keyword", "fromIndex", "dateFrom", "dateTo"]],
      ["search.embed", ["keyword"]],
      ["search.embedModels", []],
      ["search.embedTest", []],
      ["search.embedBuild", []],
      ["search.embedStatus", []],
      ["officialSearch.get", []],
      ["officialSearch.set", ["enabled"]],
      ["presets.list", []],
      ["presets.read", ["presetId", "fileName"]],
      ["presets.save", ["presetId", "fileName", "content"]],
      ["tags.list", []],
      ["tags.set", ["sessionId", "tags"]],
      ["tags.remove", ["tag"]],
      ["tags.rename", ["oldTag", "newTag"]],
      ["messages.list", ["sessionId", "limit"]],
      ["messages.truncate", ["sessionId", "seq"]],
      ["messages.edit", ["sessionId", "seq", "content"]],
      ["configfile.read", []],
      ["configfile.save", ["content"]],
      ["archived.list", []],
      ["archived.restore", ["sessionId"]],
      ["archived.delete", ["sessionId"]],
      ["trash.list", []],
      ["trash.view", ["entryDir", "limit"]],
      ["trash.restore", ["entryDir"]],
      ["trash.empty", []],
      ["trash.purge", ["entryDir"]],
      ["config.get", []],
      ["config.set", ["key", "value"]],
      ["config.reset", []],
      ["channels.configGet", ["channel", "key"]],
      ["channels.configSet", ["channel", "key", "value"]],
      ["channels.cfgGet", []],
      ["channels.cfgSet", ["patch"]],
      ["tools.gc", []],
      ["tools.debug", []],
    ].map(([method, params]) => ({
      id: `dsh-toolbox#${method}`,
      service: "dsh-toolbox-api",
      namespace: "dsh-toolbox",
      method,
      invocation: { kind: "direct" },
      parameters: params.map((wire) => ({
        name: wire,
        wire,
        source: "json",
        codec: strictCodec(`dsh-toolbox#${method}:${wire}`),
      })),
      ...(method === "search.query" || method === "search.embed" ? { cancellation: { parameter: "signal" } } : {}),
      result: strictCodec(`dsh-toolbox#${method}:result`),
    }));

    /** 设置开关定义（与后端 settings.js 一致）。 */
    const SWITCHES = [
      { key: "sessionManage", label: "会话管理", desc: "会话列表操作：删除 / 移动 / 复制 / 重设工作区根（默认：开）" },
      { key: "dialogueManage", label: "对话管理", desc: "⚠️ 需重启生效。会话内消息：截断到此 / 编辑消息（改内容并删除后续回复），操作后也需重启完整生效（默认：关）", default: false },
      { key: "workspaceManage", label: "子目录管理", desc: "工作区子目录：新增 / 重命名 / 删除 / 复制 / 移动（默认：开）" },
      { key: "presetEdit", label: "预设编辑", desc: "设置 → Agent 预设 → 自定义 agent 加「编辑」按钮（默认：开）" },

      { key: "configEditor", label: "配置编辑器", desc: "「打开配置文件」在线编辑能力，dsh 默认只读（默认：开）" },
      { key: "customSearch", label: "自研搜索", desc: "关键词搜索所有会话内容：高亮 + 跳转 + 可取消（默认：关）。⚠️ 占内存，使用后必须重启 DSH 服务才会释放" },
      { key: "officialSearch", label: "官方搜索开关", desc: "⚠️ 需重启生效。启用 dsh 官方全文搜索（SQLite 索引，占用最低，建议优先）（默认：关）", default: false },
      { key: "collapseUserMsg", label: "用户长消息折叠", desc: "你发送的消息超过「折叠行数阈值」时自动折叠显示，点击「展开全部」查看（默认：开；改后刷新页面生效）" },
      { key: "collapseAiMsg", label: "AI 长消息折叠", desc: "AI 回复超过「折叠行数阈值」时自动折叠显示（默认：关；阈值同上）", default: false },
    ];

    /** 定时心跳开关（独立分区渲染，配置项紧跟其后）。 */
    const SWITCH_HEART = { key: "scheduleTask", label: "定时心跳", desc: "定时向目标会话注入心跳消息，唤醒 AI 执行巡检/汇报等任务（类似 OpenClaw 心跳模式）。⚠️ 会消耗 token；默认：关", default: false };
    /** 提示语默认值（与后端 lib/settings.js 的 default 保持一致）。 */
    const DEFAULT_HEART_PROMPT = "【定时心跳】请检查当前是否有待办、提醒或需要主动汇报的事项；如有请简要汇报，没有则简短确认即可。";
    const DEFAULT_CRON_PROMPT = "【定时任务】现在是 {time}。请执行定时任务：检查待办与提醒、汇总值得告知用户的事项，并简明汇报。";

    /** 设置表单组件（渲染到 设置 → 工具箱 分组）。 */
    function ToolsSettingsSection(props) {
      const [doc, setDoc] = React.useState(null);
      const tools = props.tools;

      const unwrap = (resp) => (resp && typeof resp === "object" && resp.ok === true && resp.value !== undefined ? resp.value : resp);

      const refresh = React.useCallback(() => {
        if (!tools || typeof tools["config.get"] !== "function") return;
        tools["config.get"]()
          .then((resp) => setDoc(unwrap(resp) || {}))
          .catch((e) => console.error("dsh-toolbox: config.get 失败", e));
      }, [tools]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      // 折叠引擎设置同步：设置变化立即写入 window.__dsdCollapse（无需刷新页面）
      React.useEffect(() => {
        if (!doc) return;
        try {
          window.__dsdCollapse = window.__dsdCollapse || {};
          window.__dsdCollapse.userOn = doc.collapseUserMsg !== false;
          window.__dsdCollapse.userThreshold = Number(doc.collapseUserThreshold) > 0 ? Number(doc.collapseUserThreshold) : 15;
          window.__dsdCollapse.aiOn = doc.collapseAiMsg === true;
          // 重扫：已折叠的按新设置恢复/重新折叠
          if (typeof window.__dsdScan === "function") setTimeout(window.__dsdScan, 100);
        } catch {}
      }, [doc]);

      if (!tools || typeof tools["config.set"] !== "function") {
        return jsx("div", { style: { padding: 16, opacity: 0.6 }, children: "工具箱加载中…" });
      }

      const toggle = (key, value) => {
        console.log("dsh-toolbox: toggle", key, "→", value);
        try {
          tools["config.set"](key, value)
            .then((resp) => { console.log("dsh-toolbox: config.set 成功", key, "→", JSON.stringify(resp)); setDoc(unwrap(resp) || {}); })
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝", key, e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错", key, e);
        }
        // Tag 收纳开关即时生效：乐观渲染 UI + 更新全局标志并重跑注入（按钮显示/消失 + 恢复展开）
        if (key === "collapseTagBar") {
          window.__dshTagBarCfg = !!value;
          setDoc((prev) => ({ ...(prev || {}), collapseTagBar: !!value }));
          if (typeof window.__dsdTagBarApply === "function") setTimeout(window.__dsdTagBarApply, 80);
        }
      };

      const retention = doc?.trashRetentionDays ?? 7;
      const setRetention = (value) => {
        try {
          tools["config.set"]("trashRetentionDays", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(天数)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(天数)", e);
        }
      };

      const threshold = doc?.collapseUserThreshold ?? 15;
      const setThreshold = (value) => {
        try {
          tools["config.set"]("collapseUserThreshold", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(阈值)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(阈值)", e);
        }
      };
      const searchCacheSec = doc?.searchCacheSeconds ?? 120;
      const setSearchCacheSec = (value) => {
        try {
          tools["config.set"]("searchCacheSeconds", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(缓存秒数)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(缓存秒数)", e);
        }
      };
      // 语义搜索配置
      const embedMinScore = doc?.embedMinScore ?? 80;
      const setEmbedMinScore = (value) => {
        try {
          tools["config.set"]("embedMinScore", Math.max(0, Math.min(100, Math.floor(Number(value) || 50))))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(阈值)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(阈值)", e);
        }
      };
      const embedTopN = doc?.embedTopN ?? 20;
      const setEmbedTopN = (value) => {
        try {
          tools["config.set"]("embedTopN", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(条数)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(条数)", e);
        }
      };
      const [wxSegment, setWxSegment] = React.useState(1200);
      React.useEffect(() => {
        if (tools && typeof tools["channels.configGet"] === "function") {
          tools["channels.configGet"]("weixin", "segmentLimit")
            .then((resp) => { const r = unwrap(resp); if (r && r.ok) setWxSegment(Number(r.value) || 1200); })
            .catch(() => {});
        }
      }, []);
      const setWxSegmentField = (value) => {
        const v = Math.max(1, Math.min(Number(value) || 1200, 5000));
        setWxSegment(v);
        try { tools["channels.configSet"]("weixin", "segmentLimit", v).catch(() => {}); } catch {}
      };
      // 渠道会话策略（常驻开关/个数 + 继承条数；dsh-msg-hub 未加载时保持默认值）
      const [chanCfg, setChanCfg] = React.useState(null);
      React.useEffect(() => {
        if (tools && typeof tools["channels.cfgGet"] === "function") {
          tools["channels.cfgGet"]()
            .then((resp) => { const r = unwrap(resp); if (r && r.ok) setChanCfg(r); })
            .catch(() => {});
        }
      }, []);
      const embedBaseUrl = doc?.embedBaseUrl ?? "https://api.siliconflow.cn/v1";
      const embedApiKey = doc?.embedApiKey ?? "";
      const embedModel = doc?.embedModel ?? "BAAI/bge-m3";
      const setEmbedField = (key, value) => {
        try {
          tools["config.set"](key, value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(" + key + ")", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(" + key + ")", e);
        }
      };

      const [embedTestMsg, setEmbedTestMsg] = React.useState("");
      const [embedTestBusy, setEmbedTestBusy] = React.useState(false);
      const [embedModelsOpen, setEmbedModelsOpen] = React.useState(false);
      const [embedModelsList, setEmbedModelsList] = React.useState([]);
      const [embedModelsBusy, setEmbedModelsBusy] = React.useState(false);
      const [embedModelsErr, setEmbedModelsErr] = React.useState("");
      const runEmbedTest = () => {
        if (embedTestBusy) return;
        setEmbedTestBusy(true);
        setEmbedTestMsg("测试中…");
        tools["search.embedTest"]()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok) setEmbedTestMsg("✓ 连接成功：" + (r.model || "") + " · " + (r.dim || 0) + " 维 · " + (r.latencyMs || 0) + "ms");
            else setEmbedTestMsg("✗ 连接失败：" + ((r && r.error) || "未知错误"));
          })
          .catch((e) => setEmbedTestMsg("✗ 连接失败：" + String(e)))
          .finally(() => setEmbedTestBusy(false));
      };
      const fetchEmbedModels = () => {
        if (embedModelsBusy) return;
        setEmbedModelsBusy(true);
        setEmbedModelsErr("");
        tools["search.embedModels"]()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok) {
              setEmbedModelsList(r.models || []);
              setEmbedModelsOpen(true);
              if (!r.models || r.models.length === 0) setEmbedModelsErr("API 未返回可用模型");
            } else setEmbedModelsErr((r && r.error) || "获取失败");
          })
          .catch((e) => setEmbedModelsErr(String(e)))
          .finally(() => setEmbedModelsBusy(false));
      };

      const scheduleInterval = doc?.scheduleInterval ?? 60;
      const setScheduleInterval = (value) => {
        try {
          tools["config.set"]("scheduleInterval", Math.max(5, Math.floor(Number(value) || 60)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳间隔)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳间隔)", e);
        }
      };
      const schedulePrompt = doc?.schedulePrompt ?? "";
      const setSchedulePrompt = (value) => {
        try {
          tools["config.set"]("schedulePrompt", String(value || ""))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳提示语)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳提示语)", e);
        }
      };
      // 定点定时（每天/每周/每月）：JSON 存取
      let cron = { type: "off", time: "09:00", day: 1, date: 1 };
      try {
        const raw = String(doc?.scheduleCron || "off").trim();
        if (raw !== "off") cron = { ...cron, ...JSON.parse(raw) };
      } catch {}
      const setCronField = (patch) => {
        const next = { ...cron, ...patch };
        const value = next.type === "off" ? "off" : JSON.stringify({ type: next.type, time: next.time, day: next.day, date: next.date });
        try {
          tools["config.set"]("scheduleCron", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(定点定时)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(定点定时)", e);
        }
      };
      // 心跳目标会话：下拉选择（空 = 主工作区根）
      const [sessList, setSessList] = React.useState([]);
      React.useEffect(() => {
        if (!tools || typeof tools["sessions.list"] !== "function") return;
        tools["sessions.list"]()
          .then((resp) => setSessList(unwrap(resp) || []))
          .catch(() => {});
      }, [tools, unwrap]);
      // 下次触发倒计时：拉 tools.debug 的下次时间戳（60s 刷新），本地 1s tick 渲染
      const [nextTimes, setNextTimes] = React.useState({ interval: null, cron: null });
      const [, setNowTick] = React.useState(Date.now());
      React.useEffect(() => {
        if (!tools || typeof tools["tools.debug"] !== "function") return;
        let alive = true;
        const pull = () => {
          tools["tools.debug"]()
            .then((resp) => {
              if (!alive) return;
              const hb = (unwrap(resp) || {}).heartbeat || {};
              setNextTimes({ interval: hb.nextIntervalBeatAt || null, cron: hb.nextCronAt || null });
            })
            .catch(() => {});
        };
        pull();
        const t1 = setInterval(pull, 60000);
        const t2 = setInterval(() => setNowTick(Date.now()), 1000);
        return () => { alive = false; clearInterval(t1); clearInterval(t2); };
      }, [tools, unwrap]);
      const fmtCountdown = (ts) => {
        if (!ts) return null;
        const diff = ts - Date.now();
        if (diff <= 0) return "即将触发";
        const s = Math.floor(diff / 1000);
        const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
        return hh > 0 ? `${hh} 小时 ${mm} 分` : mm > 0 ? `${mm} 分 ${ss} 秒` : `${ss} 秒`;
      };
      const scheduleTarget = String(doc?.scheduleTarget || "");
      const setScheduleTarget = (value) => {
        try {
          tools["config.set"]("scheduleTarget", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳目标)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳目标)", e);
        }
      };
      const scheduleCronTarget = String(doc?.scheduleCronTarget || "");
      const setScheduleCronTarget = (value) => {
        try {
          tools["config.set"]("scheduleCronTarget", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(定点目标)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(定点目标)", e);
        }
      };
      const scheduleCronPrompt = doc?.scheduleCronPrompt ?? "";
      const setScheduleCronPrompt = (value) => {
        try {
          tools["config.set"]("scheduleCronPrompt", String(value || ""))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(定点提示语)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(定点提示语)", e);
        }
      };
      // 会话下拉选项（两个目标共用）：主工作区根 / 按工作区分组列出所有会话（含 IM 渠道，未来接新渠道自然归组）
      const baseOf = (p) => String(p || "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "未分组";
      const groups = {};
      for (const s of sessList) {
        if (s.parentSession) continue; // 子代理会话不在下拉中（独立 tab 管理）
        const g = baseOf(s.cwd);
        (groups[g] ||= []).push(s);
      }
      const sessOptions = [
        jsx("option", { key: "", value: "", children: "主工作区根（默认，内部巡检）" }),
        ...Object.keys(groups).sort().map((g) => jsx("optgroup", {
          key: g,
          label: "📁 " + g,
          children: groups[g].map((s) => jsx("option", { key: s.sessionId, value: s.sessionId, children: (s.title || "(无标题)") + " · " + s.sessionId.slice(0, 14) + "…" })),
        })),
      ];

      const row = (sw) => {
        const value = doc?.[sw.key] ?? (sw.default !== false);
        return jsx("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 0, paddingRight: 16 }, children: [
              jsx("div", { style: { fontWeight: 500 }, children: sw.label }),
              jsx("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 2 }, children: sw.desc }),
            ] }),
            jsx("input", {
              type: "checkbox",
              checked: !!value,
              onChange: (e) => toggle(sw.key, e.target.checked),
              style: { width: 18, height: 18, flex: "none" },
            }),
          ],
        });
      };

      const sectionTitle = (text) => jsx("div", {
        style: { fontSize: 12, fontWeight: 700, opacity: 0.85, padding: "10px 0 2px", borderTop: "1px solid rgba(128,128,128,0.28)", marginTop: 10, letterSpacing: 0.5 },
        children: text,
      });

      return jsx("div", {
        style: { padding: "0 4px" },
        children: [
          jsx("div", { style: { fontSize: 13, opacity: 0.7, marginBottom: 8 }, children: "每个功能可独立开关；带 ⚠️ 的切换后需重启生效。" }),

          // ── 分区〇：对话视图标签收纳（置顶 + 分隔） ──
          sectionTitle("🗂 对话视图标签收纳"),
          row({
            key: "collapseTagBar",
            label: "会话视图标签收纳（默认开）",
            desc: "在会话头部「导出」旁显示 🗂 按钮：一键收起/展开对话框上方的一排标签（记忆/技能/待办/设置…），状态自动记住。关闭后按钮消失、标签始终展开。",
          }),
          jsx("div", { style: { borderTop: "1px solid rgba(128,128,128,0.2)", marginTop: 12, paddingTop: 8 } }),

          // ── 分区一：定时心跳（开关 + 全部配置项） ──
          sectionTitle("⏰ 定时心跳"),
          row(SWITCH_HEART),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "心跳间隔（分钟，最小 5，默认 60）" }),
              jsx("span", { style: { fontSize: 11, opacity: 0.55, whiteSpace: "nowrap" }, children: fmtCountdown(nextTimes.interval) ? "⏱ 距下次 " + fmtCountdown(nextTimes.interval) : "" }),
              jsx("input", {
                type: "number",
                min: 5,
                value: scheduleInterval,
                onChange: (e) => setScheduleInterval(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "心跳提示语（{time} 自动替换为当前时间）" }),
              jsx(P.Button, {
                size: "sm", variant: "outline",
                onClick: () => { if (window.confirm("恢复默认心跳提示语？将覆盖当前内容")) setSchedulePrompt(DEFAULT_HEART_PROMPT); },
                children: "恢复默认",
              }),
            ],
          }),
          jsx("textarea", {
            value: schedulePrompt,
            onChange: (e) => setSchedulePrompt(e.target.value),
            placeholder: "留空使用默认提示语",
            rows: 2,
            style: { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none", marginBottom: 8, resize: "vertical" },
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "心跳目标会话" }),
              jsx("select", {
                value: scheduleTarget,
                onChange: (e) => setScheduleTarget(e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", maxWidth: 260 },
                children: sessOptions,
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 }, children: "间隔心跳注入到哪：主工作区 = 内部巡检；选 📱 微信/QQ/飞书 = 结果定时推送到手机（需安装 dsh-msg-hub插件，命令：dsh plugin --profile web add dsh-msg-hub）；指定会话 = 只注入该会话。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "定点定时" }),
              jsx("span", { style: { fontSize: 11, opacity: 0.55, whiteSpace: "nowrap" }, children: fmtCountdown(nextTimes.cron) ? "⏱ 距下次 " + fmtCountdown(nextTimes.cron) : "" }),
              jsx("select", {
                value: cron.type,
                onChange: (e) => setCronField({ type: e.target.value }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: [
                  jsx("option", { value: "off", children: "关闭" }),
                  jsx("option", { value: "daily", children: "每天" }),
                  jsx("option", { value: "weekly", children: "每周" }),
                  jsx("option", { value: "monthly", children: "每月" }),
                ],
              }),
              cron.type !== "off" && jsx("input", {
                type: "time",
                value: cron.time,
                onChange: (e) => setCronField({ time: e.target.value }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
              cron.type === "weekly" && jsx("select", {
                value: String(cron.day),
                onChange: (e) => setCronField({ day: Number(e.target.value) }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, i) => jsx("option", { key: i, value: String(i), children: label })),
              }),
              cron.type === "monthly" && jsx("select", {
                value: String(cron.date),
                onChange: (e) => setCronField({ date: Number(e.target.value) }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: Array.from({ length: 31 }, (_, i) => jsx("option", { key: i + 1, value: String(i + 1), children: i + 1 + " 号" })),
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "在指定时间点额外触发一次心跳（如每天 09:00、每周一 09:00、每月 1 号 09:00）。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "定点定时目标会话" }),
              jsx("select", {
                value: scheduleCronTarget,
                onChange: (e) => setScheduleCronTarget(e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", maxWidth: 260 },
                children: sessOptions,
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 }, children: "定点定时注入到哪：与间隔心跳可不同（如：间隔心跳主工作区巡检 + 每天 09:00 推送微信晨报）。选 📱 微信/QQ/飞书 = 结果定时推送到手机（需安装 dsh-msg-hub插件，命令：dsh plugin --profile web add dsh-msg-hub）。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "定点定时提示语（与间隔心跳独立）" }),
              jsx(P.Button, {
                size: "sm", variant: "outline",
                onClick: () => { if (window.confirm("恢复默认定点定时提示语？将覆盖当前内容")) setScheduleCronPrompt(DEFAULT_CRON_PROMPT); },
                children: "恢复默认",
              }),
            ],
          }),
          jsx("textarea", {
            value: scheduleCronPrompt,
            onChange: (e) => setScheduleCronPrompt(e.target.value),
            placeholder: "留空使用默认提示语",
            rows: 2,
            style: { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none", marginBottom: 8, resize: "vertical" },
          }),

          jsx("div", { style: { borderTop: "1px solid rgba(128,128,128,0.2)", marginTop: 12, paddingTop: 10 } }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("div", { style: { flex: 1, minWidth: 0 }, children: [
                jsx("div", { style: { fontWeight: 500 }, children: "微信消息分段上限" }),
                jsx("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 2 }, children: "字符/条；实测上限约 1300，默认 1200 留余量；改动即时生效。使用聊天软件机器人（微信/QQ/飞书）推送需安装 dsh-msg-hub" }),
              ] }),
              jsx("input", {
                type: "number",
                min: 1,
                max: 5000,
                value: wxSegment,
                onChange: (e) => setWxSegmentField(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),

          // ── 分区二：功能开关（含折叠） ──
          sectionTitle("🔧 功能开关"),
          ...SWITCHES.map(row),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "折叠行数阈值（用户/AI 消息超过该行数即折叠，默认 15，0 = 不折叠）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: threshold,
                onChange: (e) => setThreshold(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          // ── 分区三：搜索（通用搜索设置，关键词/语义共用） ──
          sectionTitle("🔍 搜索"),
          jsx("div", { style: { fontSize: 12, opacity: 0.75, marginBottom: 8, color: "#e5a54b" }, children: "⚠️ 搜索默认全部关闭（省内存）。开启后比较占内存：自研/语义搜索需解压会话；DSH 的内存释放机制是 Node 垃圾回收，大对象释放后堆水位不会立即下降，必须重启 DSH 服务才会彻底释放。官方搜索（SQLite 索引）不读会话文件，占用最低，建议优先使用。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "搜索缓存秒数（关键词/语义同词缓存，0 = 不缓存，默认 120）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: searchCacheSec,
                onChange: (e) => setSearchCacheSec(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 }, children: "缓存期内重复搜索同词：关键词免解压、语义免 API 调用；搜索 Tab 会显示倒计时。关键词时间范围过滤在搜索页设置。" }),

          // ── 分区四：语义搜索（地址/Key/模型 + 测试连接 + 获取模型；无开关，勾选即用） ──
          sectionTitle("🧠 语义搜索"),
          row({ key: "embedEnabled", label: "语义搜索开关", desc: "默认关。开启后搜索页才可切换到「🧠 语义」模式；⚠️ 语义搜索需解压命中会话，比较占内存，使用后必须重启 DSH 服务才会释放", default: false }),
          jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 }, children: "搜索 Tab 勾选「🧠 语义」即按语义匹配；无 Key / API 失败 / 匹配度过低自动降级为关键词搜索。配置改动即自动保存，Key 仅存本地。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "语义相关度阈值（0-100，低于该值视为噪声并降级关键词，默认 80）" }),
              jsx("input", {
                type: "number",
                min: 0,
                max: 100,
                value: embedMinScore,
                onChange: (e) => setEmbedMinScore(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "语义显示条数（只显示相关度前 N 条，0 = 不限制，默认 20）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: embedTopN,
                onChange: (e) => setEmbedTopN(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "Embedding API 地址" }),
              jsx("input", {
                type: "text",
                value: embedBaseUrl,
                onChange: (e) => setEmbedField("embedBaseUrl", e.target.value),
                placeholder: "https://api.siliconflow.cn/v1",
                style: { width: 260, fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "Embedding API Key" }),
              jsx("input", {
                type: "password",
                value: embedApiKey,
                onChange: (e) => setEmbedField("embedApiKey", e.target.value),
                placeholder: "sk-...（清空 = 禁用语义搜索）",
                style: { width: 260, fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "Embedding 模型" }),
              jsx("input", {
                type: "text",
                value: embedModel,
                onChange: (e) => setEmbedField("embedModel", e.target.value),
                placeholder: "BAAI/bge-m3",
                style: { width: 260, fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0 8px", flexWrap: "wrap" },
            children: [
              jsx(P.Button, { size: "sm", variant: "outline", disabled: embedTestBusy, onClick: runEmbedTest, children: embedTestBusy ? "测试中…" : "🔌 测试连接" }),
              jsx(P.Button, { size: "sm", variant: "outline", disabled: embedModelsBusy, onClick: fetchEmbedModels, children: embedModelsBusy ? "获取中…" : "📋 获取模型" }),
              embedTestMsg ? jsx("span", { style: { fontSize: 12, opacity: 0.85 }, children: embedTestMsg }) : null,
            ],
          }),
          embedModelsOpen ? jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "0 0 8px" },
            children: [
              jsx("label", { style: { fontSize: 12, opacity: 0.8, flex: "none" }, children: "可选模型：" }),
              jsx("select", {
                value: embedModel,
                onChange: (e) => setEmbedField("embedModel", e.target.value),
                style: { flex: 1, fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: embedModelsList.map((m) => jsx("option", { key: m, value: m, children: m })),
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setEmbedModelsOpen(false), children: "收起" }),
            ],
          }) : null,
          embedModelsErr ? jsx("div", { style: { fontSize: 12, color: "#e5534b", padding: "0 0 8px" }, children: "✗ " + embedModelsErr }) : null,

          // ── 分区五：回收站 ──
          sectionTitle("🗑️ 回收站"),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "回收站保留天数（0 = 不自动清除）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: retention,
                onChange: (e) => setRetention(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 8 }, children: "回收站自动清除：启动时 + 每 6 小时扫描一次。" }),

          // ── 分区六：渠道会话策略（dsh-msg-hub） ──
          sectionTitle("📡 渠道会话策略"),
          (() => {
            const k = chanCfg?.keepAliveSessions;
            const en = k ? !!k.enabled : true;
            const cnt = k ? Number(k.count) || 3 : 3;
            const inh = chanCfg ? Number(chanCfg.inheritRecentCount) || 10 : 10;
            const swp = chanCfg ? Number(chanCfg.sweepIntervalMinutes) || 0 : 0;
            // 本地先同步更新（受控输入不弹回），再异步保存到服务端
            const applyLocal = (patch) => {
              setChanCfg((prev) => {
                const base = prev && typeof prev === "object" ? prev : { keepAliveSessions: { enabled: true, count: 3 }, inheritRecentCount: 10, sweepIntervalMinutes: 0 };
                return {
                  ...base,
                  keepAliveSessions: { ...(base.keepAliveSessions || {}), ...(patch.keepAliveSessions || {}) },
                  ...(patch.inheritRecentCount !== undefined ? { inheritRecentCount: patch.inheritRecentCount } : {}),
                  ...(patch.sweepIntervalMinutes !== undefined ? { sweepIntervalMinutes: patch.sweepIntervalMinutes } : {}),
                };
              });
              setChan(patch);
            };
            const setChan = (patch) => {
              if (!tools || typeof tools["channels.cfgSet"] !== "function") return;
              tools["channels.cfgSet"](patch)
                .then((resp) => { const r = unwrap(resp); if (r && r.ok) setChanCfg(r); else setMsg("渠道策略保存失败：" + (r && r.error ? r.error : "")); })
                .catch((e) => setMsg("渠道策略保存失败：" + (e && e.message ? e.message : String(e))));
            };
            return jsx("div", { children: [
              jsx("div", { style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 }, children: [
                jsx("label", { style: { flex: 1 }, children: "渠道会话常驻（保留最近 N 个活跃会话，其余随用随放）" }),
                jsx("select", {
                  value: en ? "on" : "off",
                  onChange: (e) => applyLocal({ keepAliveSessions: { enabled: e.target.value === "on", count: cnt } }),
                  style: { width: 88 },
                  children: [jsx("option", { value: "on", children: "开启" }), jsx("option", { value: "off", children: "关闭" })],
                }),
              ]}),
              jsx("div", { style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 }, children: [
                jsx("label", { style: { flex: 1 }, children: "常驻个数（1~5）" }),
                jsx("input", {
                  type: "number", min: 1, max: 5, value: cnt,
                  onChange: (e) => { const v = Math.min(5, Math.max(1, Math.floor(Number(e.target.value) || 1))); applyLocal({ keepAliveSessions: { enabled: en, count: v } }); },
                  style: { width: 72 },
                }),
              ]}),
              jsx("div", { style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 }, children: [
                jsx("label", { style: { flex: 1 }, children: "自动释放间隔（分钟，0 = 不自动）" }),
                jsx("input", {
                  type: "number", min: 0, max: 60, value: swp,
                  onChange: (e) => { const v = Math.min(60, Math.max(0, Math.floor(Number(e.target.value) || 0))); applyLocal({ sweepIntervalMinutes: v }); },
                  style: { width: 72 },
                }),
              ]}),
              jsx("div", { style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 }, children: [
                jsx("label", { style: { flex: 1 }, children: "/new 记忆继承条数（1~30）" }),
                jsx("input", {
                  type: "number", min: 1, max: 30, value: inh,
                  onChange: (e) => { const v = Math.min(30, Math.max(1, Math.floor(Number(e.target.value) || 1))); applyLocal({ inheritRecentCount: v }); },
                  style: { width: 72 },
                }),
              ]}),
              jsx("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 8 }, children: "常驻 = 保留最近 N 个活跃会话在内存，其余自动释放（数据落盘不丢，下次消息自动恢复）。自动释放间隔 = 每 N 分钟自动执行一次释放（正在处理的消息不受影响），0 表示只手动释放。记忆继承条数建议最大 30，数值越大注入上下文越长、内存占用越高。也可在微信/QQ/飞书发 /cfg 查看设置。" }),
            ]});
          })(),
          jsx("div", { style: { borderTop: "1px solid rgba(128,128,128,0.2)", marginTop: 12, paddingTop: 10 } }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "6px 0 2px" },
            children: [
              jsx(P.Button, {
                size: "sm", variant: "outline",
                style: { color: "#e5534b", borderColor: "rgba(229,83,75,0.5)", fontWeight: 600 },
                onClick: () => {
                  if (!window.confirm("确定将本页所有设置恢复默认？\n\n将恢复：开关、阈值、时间范围、心跳配置等全部默认值（Embedding API Key 保留）。")) return;
                  tools["config.reset"]()
                    .then((resp) => { const d = unwrap(resp); if (d) setDoc(d); setMsg("✅ 已恢复默认设置"); })
                    .catch((e) => setMsg("恢复失败：" + (e && e.message ? e.message : String(e))));
                },
                children: "🔄 本页设置恢复默认",
              }),
            ],
          }),

        ],
      });
    }

    /** 工具箱面板：会话管理 + 回收站（子目录/搜索后续加）
     * 自绘 overlay（官方 Modal 宽度固定不可调）：桌面 760px、移动端 94vw。
     * props.list = SessionListState（root scope 注入的 useSessions 快照，含 byId/current）。
     */
    function ToolboxPanel(props) {
      const [tab, setTab] = React.useState(() => {
        try { return window.localStorage.getItem("dsh-toolbox-tab") || "sessions"; } catch { return "sessions"; }
      });
      const [sessions, setSessions] = React.useState([]);
      const [trash, setTrash] = React.useState([]);
      const [subdirs, setSubdirs] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [sessionsLoading, setSessionsLoading] = React.useState(false);
      const [trashLoading, setTrashLoading] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [gcDone, setGcDone] = React.useState(false); // 「释放内存」成功后可显示「刷新」按钮强刷页面
      const [moveFor, setMoveFor] = React.useState(null);
      const [groupDelFor, setGroupDelFor] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({});
      const [subCollapsed, setSubCollapsed] = React.useState({});
      const [tags, setTags] = React.useState({ bySession: {}, all: [] });
      const [dialogFor, setDialogFor] = React.useState(null);
      const [dialogReadonly, setDialogReadonly] = React.useState(false);
      const [dialogMsgs, setDialogMsgs] = React.useState([]);
      const [dialogBusy, setDialogBusy] = React.useState(false);

      const tools = props.tools;
      const unwrap = props.unwrap;
      const forkSession = props.forkSession;
      // 直接订阅官方 sessions store（root scope 注入的 useSessions），
      // 切会话时本组件自行重渲染，不依赖 Host 中转。
      const list = props.useSessions ? props.useSessions((s) => s) : undefined;
      const currentId = list && list.current;
      const workspaces = props.useWorkspaces ? props.useWorkspaces((s) => s) : undefined;
      const wsList = Array.isArray(workspaces) ? workspaces : (workspaces && workspaces.items) || [];
      const prevCurrent = React.useRef(currentId);
      React.useEffect(() => {
        if (prevCurrent.current !== currentId) {
          console.log("dsh-toolbox: 当前会话变化", prevCurrent.current, "→", currentId);
          prevCurrent.current = currentId;
        }
      }, [currentId]);

      const refreshSessions = React.useCallback(() => {
        setSessionsLoading(true);
        tools["sessions.list"]()
          .then((resp) => setSessions(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: sessions.list 失败", e))
          .finally(() => setSessionsLoading(false));
      }, [tools, unwrap]);

      const refreshTrash = React.useCallback(() => {
        setTrashLoading(true);
        tools["trash.list"]()
          .then((resp) => setTrash(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: trash.list 失败", e))
          .finally(() => setTrashLoading(false));
      }, [tools, unwrap]);

      const refreshSubdirs = React.useCallback(() => {
        tools["workspace.list"]()
          .then((resp) => setSubdirs(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: workspace.list 失败", e));
      }, [tools, unwrap]);

      const refreshTags = React.useCallback(() => {
        tools["tags.list"]()
          .then((resp) => setTags(unwrap(resp) || { bySession: {}, all: [] }))
          .catch((e) => console.error("dsh-toolbox: tags.list 失败", e));
      }, [tools, unwrap]);

      const [cfg, setCfg] = React.useState({});
      React.useEffect(() => {
        tools["config.get"]()
          .then((resp) => setCfg(unwrap(resp) || {}))
          .catch(() => {});
      }, [tools, unwrap]);
      const dialogueOn = cfg.dialogueManage === true; // 默认关：只有显式开启才显示对话按钮

      // 当前 tab 被开关隐藏时自动切回可用 tab
      React.useEffect(() => {
        const avail = ["sessions", "trash", "subagents", "subdirs", "presets", "config", "archived", "search"].filter((t) => {
          if (t === "sessions") return cfg.sessionManage !== false;
          if (t === "subdirs") return cfg.workspaceManage !== false;
          if (t === "search") return cfg.customSearch !== false;
          if (t === "presets") return cfg.presetEdit !== false;
          if (t === "config") return cfg.configEditor !== false;
          return true; // trash/archived 常显
        });
        if (!avail.includes(tab)) {
          const t = avail[0] || "trash";
          try { window.localStorage.setItem("dsh-toolbox-tab", t); } catch {}
          setTab(t);
        }
      }, [tab, cfg]);

      React.useEffect(() => {
        if (!props.open) return;
        refreshSessions();
        refreshSubdirs();
        refreshTags();
      }, [props.open, refreshSessions, refreshSubdirs, refreshTags]);

      // 回收站懒加载：切到该 Tab 才解压统计（全量解压较重，避免打开工具箱就吃内存）
      React.useEffect(() => {
        if (props.open && tab === "trash") refreshTrash();
      }, [props.open, tab, refreshTrash]);

      React.useEffect(() => {
        if (!props.open) return;
        const onKey = (e) => { if (e.key === "Escape") props.onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [props.open, props.onClose]);

      const run = async (label, fn) => {
        setBusy(true);
        setMsg("");
        try {
          const resp = await fn();
          const r = unwrap(resp);
          if (r && r.ok === false) {
            let detail = "";
            if (r.error) detail = typeof r.error === "object" ? (r.error.message || JSON.stringify(r.error)) : String(r.error);
            setMsg(label + " 失败：" + (detail || "未知错误"));
          } else setMsg(label + " ✅" + (r && r.needRestart ? "（需重启完整生效）" : ""));
          refreshSessions();
          refreshTrash();
        } catch (e) {
          setMsg(label + " 失败：" + (e && e.message ? e.message : String(e)));
        } finally {
          setBusy(false);
        }
      };

      const confirm = (text) => window.confirm(text);

      // 移动目标列表：仅注册工作区 + 未分组（文件系统子目录不是工作区，不列出）
      const moveTargets = [
        { type: "label", id: "lbl-ws", text: "工作区" },
        ...(wsList || []).map((w) => ({ id: w.path, label: w.path + (w.title && w.title !== w.path ? "（" + w.title + "）" : "") })),
        { type: "label", id: "lbl-ung", text: "未分组" },
        { id: "UNGROUPED", label: "移出工作区（未分组）" },
      ];

      // 一级分组：工作区根（dsh 本体层）；二级：标签（插件层）
      // 主会话列表（子代理会话在「子代理」tab 单独管理）
      const mainSessions = sessions.filter((s) => !s.parentSession);
      const subAgentSessions = sessions.filter((s) => s.parentSession);
      // 空会话数（turns === 0 且非子代理；与 emptySessionLabel 口径一致）
      const emptySessionCount = mainSessions.filter((s) => typeof s.turns === "number" && s.turns === 0).length;
      const registeredPaths = new Set((wsList || []).map((w) => w.path));
      const byRoot = {};
      for (const s of mainSessions) {
        const root = registeredPaths.has(s.cwd) ? s.cwd : "(未分组)";
        (byRoot[root] ||= []).push(s);
      }
      const rootGroups = Object.keys(byRoot).sort((a, b) => (a === "(未分组)" ? 1 : b === "(未分组)" ? -1 : 0));
      // 当前会话所在一级组（默认折叠：非当前组折叠，当前组展开）
      const curSession = sessions.find((x) => x.sessionId === currentId);
      const currentRoot = curSession ? (registeredPaths.has(curSession.cwd) ? curSession.cwd : "(未分组)") : null;
      const mainTag = (sid) => (tags.bySession[sid] || [])[0] || "(未标记)";
      const currentTag = curSession ? mainTag(curSession.sessionId) : null;
      const isCollapsed = (g) => (collapsed[g] === undefined ? g !== currentRoot : collapsed[g]);
      const toggleCollapsed = (g) => setCollapsed({ ...collapsed, [g]: !isCollapsed(g) });
      // 二级（标签小节）折叠：默认展开
      const isSubCollapsed = (k) => !!subCollapsed[k];
      const toggleSubCollapsed = (k) => setSubCollapsed({ ...subCollapsed, [k]: !subCollapsed[k] });

      // 打标签：打开点选式标签编辑器（已有标签点击即选，避免手输错字符）
      const [tagEditorFor, setTagEditorFor] = React.useState(null);
      const editTags = (sessionId) => setTagEditorFor(sessionId);


      // 对话管理：打开消息面板
      const openDialog = (sessionId) => {
        setDialogFor(sessionId);
        setDialogMsgs([]);
        tools["messages.list"](sessionId, 30)
          .then((resp) => { const r = unwrap(resp); setDialogMsgs((r && r.messages) || []); })
          .catch((e) => setMsg("消息读取失败：" + (e && e.message ? e.message : String(e))));
      };
      // 回收站查看：读回收站 data 目录的消息（只读）
      const openTrashView = (entryDir, title) => {
        setDialogFor("trash:" + entryDir);
        setDialogMsgs([]);
        setDialogReadonly(true);
        tools["trash.view"](entryDir, 30)
          .then((resp) => { const r = unwrap(resp); setDialogMsgs((r && r.messages) || []); })
          .catch((e) => setMsg("消息读取失败：" + (e && e.message ? e.message : String(e))));
        setMsg("回收站查看：正在加载「" + (title || entryDir) + "」…");
      };
      // 复制完整会话 ID（悬停/点击副行也可复制）；成功后提示完整 ID 以方便核对/定位
      const copyId = (id, e) => {
        if (e) e.stopPropagation();
        const done = () => setMsg("已复制会话 ID ✅ " + id);
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(id).then(done).catch(() => { fallbackCopy(id); done(); });
          } else { fallbackCopy(id); done(); }
        } catch { fallbackCopy(id); done(); }
      };
      const fallbackCopy = (text) => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {}
      };
      const dialogRun = (label, fn, after) => {
        setDialogBusy(true);
        fn()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) setMsg(label + " 失败：" + (r.error || ""));
            else {
              setMsg(label + " ✅ 已修改会话文件（需重启容器完整生效；重启前请勿继续使用该会话）");
              if (after) after();
            }
          })
          .catch((e) => setMsg(label + " 失败：" + (e && e.message ? e.message : String(e))))
          .finally(() => setDialogBusy(false));
      };

      // 批量删除（当前会话跳过）
      const delSessions = (list, label) => {
        const deletable = list.filter((s) => s.sessionId !== currentId);
        if (deletable.length === 0) { setMsg("没有可删除的会话（当前会话除外）"); return; }
        if (!confirm("删除" + label + "下 " + deletable.length + " 个会话？全部移入回收站，左侧立即隐藏")) return;
        setBusy(true);
        setMsg("");
        let done = 0, failed = 0;
        Promise.all(deletable.map((s) =>
          tools["sessions.delete"](s.sessionId)
            .then((resp) => { const rr = unwrap(resp); if (rr && rr.ok === false) failed += 1; else done += 1; })
            .catch(() => { failed += 1; })
        ))
          .then(() => { setMsg("删除完成：" + done + " 个已删除" + (failed ? "，" + failed + " 个失败" : "")); refreshSessions(); })
          .finally(() => setBusy(false));
      };

      const sessionRow = (sess) => {
        const sum = list && list.byId ? list.byId[sess.sessionId] : undefined;
        const title = emptySessionLabel(sess) || (sum && sum.displayTitle) || "(无标题)";
        const isCurrent = sess.sessionId === currentId;
        const short = sess.sessionId.length > 20 ? sess.sessionId.slice(0, 17) + "…" : sess.sessionId;
        const shortCwd = sess.cwd && sess.cwd.length > 24 ? "…" + sess.cwd.slice(-21) : (sess.cwd || "");
        return jsx("div", {
          key: sess.sessionId,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px 6px 24px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap", background: isCurrent ? "rgba(47,125,50,0.14)" : "transparent", borderRadius: 4 },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 }, children: [
                isCurrent ? jsx("span", { style: { flex: "none", fontSize: 11, fontWeight: 600, color: "#fff", background: "#2f7d32", borderRadius: 4, padding: "1px 5px" }, children: "当前" }) : null,
                (tags.bySession[sess.sessionId] || []).map((tg) => jsx("span", { key: tg, style: { flex: "none", fontSize: 10, background: "rgba(80,120,255,0.25)", color: "#9db8ff", borderRadius: 4, padding: "1px 5px" }, children: tg })),
                jsx("span", { style: { fontSize: 13, fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: title }),
              ] }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "copy", textDecoration: "underline dotted rgba(128,128,128,0.4)", title: sess.sessionId + "（点击复制完整 ID）" },
                onClick: (e) => copyId(sess.sessionId, e),
                children: "📋 " + short + (shortCwd ? " · " + shortCwd : ""),
              }),
              // 大小/轮次单独一行：不再与 ID 挤一行被截断遮挡
              fmtStats(sess) ? jsx("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: "📦 " + fmtStats(sess) }) : null,
              sess.latest ? jsx("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: "💬 " + sess.latest }) : null,
            ] }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => { setDialogReadonly(true); openDialog(sess.sessionId); },
              title: "查看会话内容（只读）",
              children: "👁 查看",
            }),
            dialogueOn && jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => { setDialogReadonly(false); openDialog(sess.sessionId); },
              title: isCurrent ? "当前会话可查看，截断/编辑需重启后操作" : undefined,
              children: "💬 对话",
            }),
            jsx(P.Button, { size: "sm", disabled: busy, onClick: () => editTags(sess.sessionId), children: "🏷 标签" }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => {
                if (!confirm("分叉复制会话「" + title + "」？")) return;
                setBusy(true); setMsg("");
                Promise.resolve(props.forkSession(sess.sessionId))
                  .then((newId) => { setMsg("复制 ✅ 新会话：" + (newId || "")); refreshSessions(); })
                  .catch((e) => {
                const m = e && e.message ? e.message : String(e);
                setMsg(m.includes("fork-unavailable") || m.includes("no completed turn") ? "复制 失败：该会话没有已完成的对话（空会话），无法分叉" : "复制 失败：" + m);
              })
                  .finally(() => setBusy(false));
              },
              children: "复制",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent, title: isCurrent ? "当前会话不可删除" : undefined,
              onClick: () => confirm("删除会话「" + title + "」？文件将移入回收站（可恢复），左侧立即隐藏") && run("删除", () => tools["sessions.delete"](sess.sessionId)),
              children: "删除",
            }),
            jsx(P.Menu, {
              portal: true,
              open: moveFor === sess.sessionId,
              anchor: jsx(P.Button, {
                size: "sm", disabled: busy || isCurrent || moveFor !== null, title: isCurrent ? "当前会话不可移动" : undefined,
                onClick: () => setMoveFor(moveFor === sess.sessionId ? null : sess.sessionId),
                children: "移动▾",
              }),
              items: moveTargets,
              onSelect: (id) => {
                setMoveFor(null);
                if (id === "UNGROUPED") { run("移出工作区", () => tools["sessions.detach"](sess.sessionId)).then(refreshSessions); return; }
                run("移动", () => tools["sessions.move"](id, sess.sessionId)).then(refreshSessions);
              },
              onClose: () => setMoveFor(null),
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent, title: isCurrent ? "当前会话不可重设" : undefined,
              onClick: () => confirm("重设「" + title + "」的工作区根为当前根？") && run("重设", () => tools["sessions.resetCwd"](sess.sessionId)),
              children: "重设",
            }),
          ],
        });
      };

      const trashRow = (item) => {
        const name = emptySessionLabel(item) || item.title || item.name;
        return jsx("div", {
          key: item.entryDir,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: name }, children: (item.type === "session" ? "[会话] " : "[目录] ") + name }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: item.type === "session" ? "copy" : undefined, textDecoration: item.type === "session" ? "underline dotted rgba(128,128,128,0.4)" : undefined, title: item.type === "session" ? (item.name || "") + "（点击复制完整 ID）" : undefined },
                onClick: item.type === "session" ? (e) => copyId(item.name || "", e) : undefined,
                children: (item.type === "session" ? "📋 " : "") + new Date(item.deletedAt).toLocaleString() + (fmtStats(item) ? " · " + fmtStats(item) : ""),
              }),
            ] }),
            item.type === "session" && jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => openTrashView(item.entryDir, item.title || item.name),
              title: "查看被删会话内容（只读）",
              children: "👁 查看",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => run("恢复", () => tools["trash.restore"](item.entryDir)).then(() => {
                setMsg("恢复成功，正在刷新列表…");
                setTimeout(() => window.location.reload(), 900);
              }),
              children: "恢复",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => confirm("彻底删除回收站中的「" + name + "」？不可恢复！") && run("彻底删除", () => tools["trash.purge"](item.entryDir)),
              children: "彻底删除",
            }),
          ],
        });
      };

      const tabBtn = (id, label, icon) => jsx(P.Button, {
        size: "sm",
        variant: tab === id ? "primary" : "outline",
        onClick: () => { setMsg(""); try { window.localStorage.setItem("dsh-toolbox-tab", id); } catch {} setTab(id); },
        style: { marginRight: 6, marginBottom: 4, fontWeight: tab === id ? 700 : 400 },
        children: icon + " " + label,
      });

      if (!props.open) return null;
      const overlayStyle = {
        position: "fixed", inset: 0, zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", padding: 12,
      };
      const cardStyle = {
        background: "var(--dsw-alias-bg-layer-1, #202024)",
        color: "var(--dsw-alias-label-primary, #eee)",
        borderRadius: 12, padding: "14px 16px 16px", boxSizing: "border-box",
        width: "min(760px, 94vw)", maxWidth: "94vw", maxHeight: "80vh", overflowY: "auto",
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      };
      return jsx("div", {
        style: overlayStyle,
        "data-dsh-toolbox-overlay": "1",
        onClick: (e) => {
          if (window.__dsdDrag) { e.stopPropagation(); return; }
          props.onClose();
        },
        children: [
        jsx("div", {
        style: cardStyle,
        onClick: (e) => { e.stopPropagation(); if (window.__dsdDrag) window.__dsdDrag = false; },
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }, children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600 }, children: "🧰 工具箱" }),
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
              jsx(P.Button, {
                size: "sm", variant: "outline", disabled: busy,
                onClick: () => {
                  setBusy(true); setMsg(""); setGcDone(false);
                  tools["tools.gc"]()
                    .then((resp) => {
                      const r = unwrap(resp);
                      setMsg(r && r.ok === false ? "释放失败：" + (r.error || "") : (r && r.note) || "已执行");
                      if (r && r.ok !== false) setGcDone(true);
                    })
                    .catch((e) => setMsg("释放失败：" + (e && e.message ? e.message : String(e))))
                    .finally(() => setBusy(false));
                },
                title: "清空插件缓存并尝试触发 GC（彻底释放需重启容器）",
                children: "🧹 释放内存",
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: props.onClose, children: "✕" }),
            ] }),
          ] }),
          jsx("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", marginBottom: 8 }, children: [
            cfg.sessionManage !== false && tabBtn("sessions", "会话", "💬"),
            tabBtn("trash", "回收站", "🗑️"),
            tabBtn("subagents", "子代理", "🧬"),
            cfg.workspaceManage !== false && tabBtn("subdirs", "子目录", "📁"),
            cfg.presetEdit !== false && tabBtn("presets", "预设", "⚙️"),
            cfg.configEditor !== false && tabBtn("config", "配置", "📄"),
            tabBtn("archived", "归档", "🗄"),
            cfg.customSearch !== false && tabBtn("search", "搜索", "🔍"),
          ] }),
          msg ? jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6, opacity: 0.85 }, children: [
            jsx("span", { style: { flex: 1, minWidth: 0 }, children: msg }),
            gcDone ? jsx(P.Button, { size: "sm", variant: "outline", onClick: () => window.location.reload(), title: "强刷页面：释放后的内存才能真正回落（前端 bundle 重新加载）", children: "♻️ 刷新" }) : null,
          ] }) : null,
          tab === "sessions" && jsx("div", {
            children: [
              // 顶部操作区：清除空会话（与回收站「清空回收站」同位；空会话 = turns 0 且非子代理）
              jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }, children: [
                jsx(P.Button, {
                  size: "sm",
                  variant: "outline",
                  disabled: busy || emptySessionCount === 0,
                  onClick: () => {
                    if (!confirm("清除 " + emptySessionCount + " 个空会话？全部移入回收站，左侧立即隐藏")) return;
                    run("清除空会话", () => tools["sessions.clearEmpty"]()).then((r) => {
                      const rr = unwrap(r);
                      // RPC 失败（rr 为空）或服务端报错时，run 已设置错误提示，这里不再覆盖
                      if (!rr || rr.ok === false) return;
                      setMsg("已清除 " + rr.removed + " 个空会话" + (rr.failed ? "，" + rr.failed + " 个失败" : ""));
                      refreshSessions();
                    });
                  },
                  children: "清除空会话" + (emptySessionCount > 0 ? " (" + emptySessionCount + ")" : ""),
                }),
                jsx("div", { style: { fontSize: 11, opacity: 0.6 }, children: "空会话 = 0 轮对话；删除进回收站可恢复" }),
              ]}),
              sessionsLoading && mainSessions.length === 0
              ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
              : mainSessions.length === 0
                ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有会话" })
                : rootGroups.map((root) => {
                  // 组内二级：按标签分小节
                  const byTagIn = {};
                  for (const s of byRoot[root]) (byTagIn[mainTag(s.sessionId)] ||= []).push(s);
                  return jsx("div", {
                    key: root,
                    children: [
                      jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 4px 2px" }, children: [
                        jsx("div", {
                          style: {
                            flex: 1, fontSize: 12,
                            fontWeight: root === currentRoot ? 700 : 500,
                            opacity: root === currentRoot ? 1 : 0.6,
                            color: root === "(未分组)" ? "#e8a33d" : "#4caf50", // 正式工作区绿、未分组橙（通用，不写死具体路径）
                            cursor: "pointer", userSelect: "none",
                          },
                          onClick: () => toggleCollapsed(root),
                          children: (isCollapsed(root) ? "▸ " : "▾ ") + (root === "(未分组)" ? "🗂 未分组" : "📁 " + String(root).replace(/[/\\]+$/, "").split(/[/\\]/).pop()) + "（" + byRoot[root].length + "）" + (root === currentRoot ? " ◀" : ""),
                        }),
                        jsx(P.Button, {
                          size: "sm", variant: "outline", disabled: busy,
                          onClick: () => delSessions(byRoot[root], root === "(未分组)" ? "未分组" : "「" + root + "」"),
                          children: "删除分组",
                        }),
                      ] }),
                      isCollapsed(root) ? null : Object.keys(byTagIn).map((tag) => jsx("div", {
                        key: root + ":" + tag,
                        children: [
                          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px 0 16px" }, children: [
                            jsx("div", {
                              style: {
                                flex: 1, fontSize: 11,
                                fontWeight: tag === currentTag && root === currentRoot ? 700 : 500,
                                opacity: tag === currentTag && root === currentRoot ? 1 : 0.65,
                                color: tag === "(未标记)" ? undefined : "#9db8ff",
                                cursor: "pointer", userSelect: "none",
                              },
                              onClick: () => toggleSubCollapsed(root + ":" + tag),
                              children: (isSubCollapsed(root + ":" + tag) ? "▸ " : "▾ ") + (tag === "(未标记)" ? "🗂 未标记" : "🏷 " + tag) + "（" + byTagIn[tag].length + "）" + (tag === currentTag && root === currentRoot ? " ◀" : ""),
                            }),
                            tag !== "(未标记)" && jsx(P.Button, {
                              size: "sm", variant: "outline", disabled: busy,
                              onClick: () => {
                                if (!confirm("删除标签「" + tag + "」？该标签将从所有会话移除（会话本身不动）")) return;
                                run("删除标签", () => tools["tags.remove"](tag)).then(refreshTags);
                              },
                              children: "删标签",
                            }),
                          ] }),
                          isSubCollapsed(root + ":" + tag) ? null : byTagIn[tag].map(sessionRow),
                        ],
                      })),
                    ],
                  });
                }),
              ],
          }),
          tab === "trash" && jsx("div", {
            children: [
              jsx("div", { style: { marginBottom: 6 }, children: jsx(P.Button, { size: "sm", disabled: busy || trash.length === 0, onClick: () => confirm("清空回收站？不可恢复！") && run("清空", () => tools["trash.empty"]()), children: "清空回收站" }) }),
              trashLoading && trash.length === 0
                ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
                : trash.length === 0
                  ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "回收站是空的" })
                  : trash.map(trashRow),
            ],
          }),
          tab === "subagents" && jsx("div", {
            children: subAgentSessions.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有子代理会话（子代理会话由 dsh 在任务委托时自动创建）" })
              : (() => {
                  // 按父会话分组
                  const parentTitles = {};
                  for (const s of mainSessions) parentTitles[s.sessionId] = s.title || s.sessionId.slice(0, 12);
                  const byParent = {};
                  for (const s of subAgentSessions) (byParent[s.parentSession] ||= []).push(s);
                  return Object.keys(byParent).map((pid) => jsx("div", {
                    key: pid,
                    style: { marginBottom: 8 },
                    children: [
                      jsx("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85, padding: "6px 2px 2px" }, children: "🧬 父会话：" + (parentTitles[pid] || pid.slice(0, 12)) + "（" + byParent[pid].length + "）" }),
                      byParent[pid].map((s) => jsx("div", {
                        key: s.sessionId,
                        style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)" },
                        children: [
                          jsx("div", { style: { flex: 1, minWidth: 0 }, children: [
                            jsx("div", { style: { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: s.title || "（无标题）" }),
                            jsx("div", { style: { fontSize: 11, opacity: 0.55 }, children: (s.cwd || "") + " · " + (s.turns || 0) + " 轮 · " + (s.size ? (s.size / 1024).toFixed(0) + "KB" : "") }),
                            s.latest ? jsx("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: "💬 " + s.latest }) : null,
                          ] }),
                          jsx(P.Button, { size: "sm", variant: "outline", onClick: () => { setDialogReadonly(true); openDialog(s.sessionId); }, children: "查看" }),
                          jsx(P.Button, { size: "sm", variant: "outline", onClick: () => { props.onClose && props.onClose(); props.openSession(s.sessionId); }, children: "打开" }),
                          jsx(P.Button, { size: "sm", variant: "outline", onClick: () => copyId(s.sessionId), children: "复制 ID" }),
                          jsx(P.Button, { size: "sm", variant: "outline", onClick: () => confirm("删除子代理会话「" + (s.title || s.sessionId.slice(0, 12)) + "」？文件将移入回收站（可恢复）") && run("删除", () => tools["sessions.delete"](s.sessionId), refreshSessions), children: "删除" }),
                        ],
                      })),
                    ],
                  }));
                })(),
          }),
          (tab === "subdirs") && jsx(SubdirsTab, { tools, unwrap, run, confirm, subdirs, refreshSubdirs, sessions, currentId, refreshSessions, wsList }),
          (tab === "search") && jsx(SearchTab, { tools, unwrap, list, openSession: props.openSession, onClose: props.onClose }),
          (tab === "presets") && jsx(PresetsTab, { tools, unwrap, run }),
          (tab === "config") && jsx(ConfigTab, { tools, unwrap }),
          (tab === "archived") && jsx(ArchivedTab, { tools, unwrap, run, confirm, busy, currentId, openView: (id) => { setDialogReadonly(true); openDialog(id); }, onCopy: copyId }),
        ],
      }),
        dialogFor && jsx(DialogOverlay, {
          msgs: dialogMsgs,
          busy: dialogBusy,
          readonly: dialogReadonly,
          isCurrent: dialogFor === currentId,
          summary: dialogFor
            ? dialogFor.startsWith("trash:")
              ? "回收站：" + (trash.find((t) => dialogFor === "trash:" + t.entryDir)?.title || "")
              : (list && list.byId && list.byId[dialogFor] ? list.byId[dialogFor].displayTitle : dialogFor)
            : "",
          id: dialogFor
            ? dialogFor.startsWith("trash:")
              ? (trash.find((t) => dialogFor === "trash:" + t.entryDir)?.name || "")
              : dialogFor
            : "",
          onCopy: copyId,
          onClose: () => setDialogFor(null),
          onJump: dialogFor && dialogFor.startsWith("trash:")
            ? null
            : () => { setDialogFor(null); props.onClose(); openSession(dialogFor); },
          onTruncate: (m) => {
            const sum = list && list.byId ? list.byId[dialogFor] : undefined;
            if (sum && sum.running) { alert("该会话正在运行（AI 回复中），请等待完成后操作"); return; }
            if (!confirm("截断到此？将删除「" + m.content.slice(0, 30) + "…」及之后所有消息。")) return;
            dialogRun("截断", () => tools["messages.truncate"](dialogFor, m.seq), () => openDialog(dialogFor));
          },
          onEdit: (m) => {
            const sum = list && list.byId ? list.byId[dialogFor] : undefined;
            if (sum && sum.running) { alert("该会话正在运行（AI 回复中），请等待完成后操作"); return; }
            const next = window.prompt("新内容（保存后删除后续回复）：", m.content);
            if (next === null || !next.trim()) return;
            dialogRun("编辑", () => tools["messages.edit"](dialogFor, m.seq, next), () => openDialog(dialogFor));
          },
        }),
        tagEditorFor && jsx(TagEditor, {
          title: list && list.byId && list.byId[tagEditorFor] ? list.byId[tagEditorFor].displayTitle : tagEditorFor,
          current: tags.bySession[tagEditorFor] || [],
          all: tags.all || [],
          bySession: tags.bySession || {},
          busy,
          run,
          onTagsChanged: refreshTags,
          onClose: () => setTagEditorFor(null),
          onSave: (next) => {
            run("标签", () => tools["tags.set"](tagEditorFor, next)).then(refreshTags);
            setTagEditorFor(null);
          },
        }),
      ] });
    }

    /** 通用代码编辑器：自动换行（默认勾选）+ 全屏（Esc/再点退出）+ 保存 */
    function CodeEditor(props) {
      const { title, initial, onSave, onClose } = props;
      const [value, setValue] = React.useState(initial);
      // initial 变化时重置内容（防止连续打开不同文件时显示旧内容）
      React.useEffect(() => {
        setValue(initial);
      }, [initial]);
      const [wrap, setWrap] = React.useState(true);
      const [full, setFull] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [err, setErr] = React.useState("");
      const [height, setHeight] = React.useState(320);
      const heightRef = React.useRef(320);
      const setH = (v) => { heightRef.current = v; setHeight(v); };

      // 自绘拖条：document 级事件 + 高度硬限制（200px ~ 70vh），横向不可调
      const startDrag = (e) => {
        e.preventDefault();
        window.__dsdDrag = true; // 拖拽标志：拖后 100ms 内的 click 视为拖拽残留
        const getY = (ev) => (ev.touches && ev.touches.length > 0 ? ev.touches[0].clientY : ev.clientY);
        const startY = getY(e);
        const startH = heightRef.current;
        const onMove = (ev) => {
          ev.preventDefault();
          const next = Math.min(Math.max(startH + (getY(ev) - startY), 200), Math.floor(window.innerHeight * 0.7));
          setH(next);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.removeEventListener("touchmove", onMove);
          document.removeEventListener("touchend", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          setTimeout(() => { window.__dsdDrag = false; }, 120);
        };
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
      };

      React.useEffect(() => {
        if (!full) return;
        const onKey = (e) => { if (e.key === "Escape") setFull(false); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [full]);

      const save = async () => {
        setSaving(true);
        setErr("");
        try {
          await onSave(value);
          onClose();
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };

      const editorStyle = {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13, lineHeight: 1.6,
        whiteSpace: wrap ? "pre-wrap" : "pre",
        wordBreak: wrap ? "break-word" : "normal",
        overflowX: wrap ? "hidden" : "auto",
        overflowY: "auto",
        width: "100%", height: full ? "auto" : height + "px", flex: full ? 1 : "none",
        resize: "none", // 禁用原生拖拽，用自绘拖条
        boxSizing: "border-box", padding: 10, borderRadius: 8,
        border: "1px solid rgba(128,128,128,0.35)",
        background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none",
      };
      const overlayStyle = full ? {
        position: "fixed", inset: 0, zIndex: 2000, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.72)", padding: 12,
      } : null;
      const cardStyle = full
        ? { width: "min(1100px, 96vw)", height: "min(92vh, 1000px)", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-1, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }
        : { width: "100%", background: "var(--dsw-alias-bg-layer-1, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" };

      return jsx("div", { style: overlayStyle, onClick: full ? (e) => { if (window.__dsdDrag) { e.stopPropagation(); return; } if (e.target === e.currentTarget) setFull(false); } : undefined, children: jsx("div", {
        style: cardStyle,
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: title }),
            jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }, children: [
              jsx("input", { type: "checkbox", checked: wrap, onChange: (e) => setWrap(e.target.checked) }),
              "自动换行",
            ] }),
            jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setFull(!full), children: full ? "退出全屏" : "全屏" }),
            jsx(P.Button, { size: "sm", variant: "outline", disabled: saving, onClick: onClose, children: "取消" }),
            jsx(P.Button, { size: "sm", variant: "primary", disabled: saving, onClick: save, children: saving ? "保存中…" : "保存" }),
          ] }),
          err ? jsx("div", { style: { fontSize: 12, color: "#f27474", marginBottom: 6 }, children: err }) : null,
          jsx("textarea", {
            value: value,
            onChange: (e) => setValue(e.target.value),
            spellCheck: false,
            style: editorStyle,
          }),
          !full && jsx("div", {
            onMouseDown: startDrag,
            style: { height: 6, cursor: "ns-resize", background: "rgba(128,128,128,0.28)", borderRadius: 3, marginTop: 6, flex: "none", touchAction: "none" },
            title: "拖动调节高度（200px ~ 视口 70%）",
          }),
        ],
      }) });
    }

    /** 预设编辑 Tab */
    function PresetsTab(props) {
      const { tools, unwrap, run } = props;
      const [presets, setPresets] = React.useState([]);
      const [editing, setEditing] = React.useState(null); // {presetId, fileName, content, title}
      const [loading, setLoading] = React.useState(false);

      const refresh = React.useCallback(() => {
        setLoading(true);
        tools["presets.list"]()
          .then((resp) => setPresets(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: presets.list 失败", e))
          .finally(() => setLoading(false));
      }, [tools, unwrap]);

      React.useEffect(() => { refresh(); }, [refresh]);

      const openFile = (presetId, fileName) => {
        tools["presets.read"](presetId, fileName)
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) { alert("读取失败：" + (r.error || "")); return; }
            setEditing({ presetId, fileName, content: r.content, title: presetId + " / " + fileName });
          })
          .catch((e) => alert("读取失败：" + (e.message || e)));
      };

      const saveFile = (content) => {
        return tools["presets.save"](editing.presetId, editing.fileName, content).then((resp) => {
          const r = unwrap(resp);
          if (r && r.ok === false) throw new Error(r.error || "保存失败");
          return r;
        });
      };

      const row = (p) => jsx("div", {
        key: p.id,
        style: { padding: "8px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)" },
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, minWidth: 140 }, children: [
              jsx("div", { style: { fontSize: 13, fontWeight: 600 }, children: p.name || p.id }),
              jsx("div", { style: { fontSize: 11, opacity: 0.6 }, children: p.id }),
            ] }),
            p.files.map((f) => jsx(P.Button, {
              key: f.name, size: "sm", variant: "outline",
              onClick: () => openFile(p.id, f.name),
              children: "编辑 " + f.name,
            })),
          ] }),
          p.description ? jsx("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 4 }, children: p.description }) : null,
        ],
      });

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "编辑 Agent 预设文件（~/.agent-presets），保存即时生效，新会话生效" }),
            jsx(P.Button, { size: "sm", onClick: refresh, children: "刷新" }),
          ] }),
          loading && presets.length === 0
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : presets.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有自定义预设" })
              : presets.map(row),
          editing ? jsx(CodeEditor, {
            key: editing.presetId + ":" + editing.fileName,
            title: editing.title,
            initial: editing.content,
            onSave: saveFile,
            onClose: () => setEditing(null),
          }) : null,
        ],
      });
    }

    /** 对话管理面板：消息列表 + 截断/编辑（安全模型：只删尾或改尾） */
    function DialogOverlay(props) {
      const { msgs, busy, isCurrent, onClose, onTruncate, onEdit, summary, readonly, onJump, id, onCopy } = props;
      const [expanded, setExpanded] = React.useState({});
      const [copied, setCopied] = React.useState(false);
      const roleLabel = (r) => r === "user" ? "我" : "AI";
      const roleColor = (r) => r === "user" ? "#4caf50" : "#4a8fd6";
      const fmtTime = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
      const doCopy = () => {
        if (!onCopy || !id) return;
        onCopy(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };

      return jsx("div", {
        style: { position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", padding: 12 },
        onClick: (e) => { if (window.__dsdDrag) { e.stopPropagation(); return; } onClose(); },
        children: jsx("div", {
          style: { width: "min(680px, 94vw)", maxHeight: "78vh", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-1, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }, children: [
              jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600 }, children: (readonly ? "👁 会话内容：" : "💬 对话管理：") + (summary || "") }),
              onJump && jsx(P.Button, {
                size: "sm", variant: "outline",
                onClick: onJump,
                title: "关闭工具箱并打开此会话（不挡页面）",
                children: "跳转到此会话",
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "关闭" }),
            ] }),
            id ? jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap", fontSize: 10, opacity: 0.6 }, children: [
              jsx("span", { style: { wordBreak: "break-all", flex: 1, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace" }, children: "ID: " + id }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: doCopy, title: "复制完整会话 ID（NAS 定位会话文件用）", children: copied ? "已复制 ✓" : "📋 复制 ID" }),
            ] }) : null,
            jsx("div", { style: { fontSize: 11, opacity: 0.65, marginBottom: 8 }, children: readonly
              ? "只读查看会话内容（最近 30 条消息）。"
              : "截断 = 删除本条及之后所有消息；编辑 = 改本条内容并删除后续回复。" + (isCurrent ? " ⚠️ 当前会话：操作后必须重启才生效，重启前请勿继续在此会话对话（否则事件序号错乱会损坏会话）。" : " 修改后需重启完整生效。") }),
            jsx("div", { style: { flex: 1, overflowY: "auto", border: "1px solid rgba(128,128,128,0.15)", borderRadius: 8, padding: 8 }, children: [
              msgs.length === 0
                ? jsx("div", { style: { opacity: 0.5, padding: 12, fontSize: 13 }, children: "没有消息" })
                : msgs.map((m) => {
                    const isExp = !!expanded[m.seq];
                    const preview = m.content.length > 200 && !isExp ? m.content.slice(0, 200) + "…" : m.content;
                    return jsx("div", {
                      key: m.seq,
                      style: { padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.1)" },
                      children: [
                        jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }, children: [
                          jsx("span", { style: { flex: "none", fontSize: 11, fontWeight: 600, color: roleColor(m.role), borderRadius: 4, padding: "1px 6px", background: roleColor(m.role) + "22" }, children: roleLabel(m.role) }),
                          jsx("span", { style: { fontSize: 11, opacity: 0.5 }, children: fmtTime(m.time) + " · seq " + m.seq }),
                          jsx("div", { style: { flex: 1 } }),
                          !readonly && jsx(P.Button, {
                            size: "sm", disabled: busy,
                            onClick: () => onTruncate(m),
                            children: "截断到此",
                          }),
                          !readonly && jsx(P.Button, {
                            size: "sm", disabled: busy,
                            onClick: () => onEdit(m),
                            children: "编辑",
                          }),
                        ] }),
                        jsx("div", {
                          style: { fontSize: 12, lineHeight: 1.5, cursor: m.content.length > 200 ? "pointer" : undefined, whiteSpace: "pre-wrap", wordBreak: "break-word" },
                          onClick: () => m.content.length > 200 && setExpanded({ ...expanded, [m.seq]: !isExp }),
                          children: preview,
                        }),
                      ],
                    });
                  }),
            ] }),
          ],
        }),
      });
    }

    /** 配置文件在线编辑 Tab（插件化，替代 dsh-patches） */
    function ConfigTab(props) {
      const { tools, unwrap } = props;
      const [path, setPath] = React.useState("");
      const [content, setContent] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [err, setErr] = React.useState("");
      const [savedMsg, setSavedMsg] = React.useState("");

      const load = () => {
        setLoading(true);
        setErr("");
        tools["configfile.read"]()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) { setErr(r.error || "读取失败"); setContent(null); return; }
            setPath(r.path || "");
            setContent(r.content || "");
          })
          .catch((e) => setErr("读取失败：" + (e && e.message ? e.message : String(e))))
          .finally(() => setLoading(false));
      };
      React.useEffect(() => { load(); }, []);

      const save = (text) => {
        setSavedMsg("");
        return tools["configfile.save"](text).then((resp) => {
          const r = unwrap(resp);
          if (r && r.ok === false) throw new Error(r.error || "保存失败");
          setSavedMsg("已保存到 " + (r.path || path) + "（需重启容器生效）");
          return r;
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "dsh 配置文件在线编辑（YAML 校验 + 原子写，保存后需重启生效）" }),
            jsx(P.Button, { size: "sm", onClick: load, children: "重新加载" }),
          ] }),
          path ? jsx("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 }, children: "文件：" + path }) : null,
          err ? jsx("div", { style: { fontSize: 12, color: "#f27474", marginBottom: 6 }, children: err }) : null,
          savedMsg ? jsx("div", { style: { fontSize: 12, color: "#4caf50", marginBottom: 6 }, children: savedMsg }) : null,
          loading && content === null
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : content !== null
              ? jsx(CodeEditor, {
                  key: "config:" + path,
                  title: "配置文件：" + (path || "settings"),
                  initial: content,
                  onSave: save,
                  onClose: () => {},
                })
              : null,
        ],
      });
    }

    /** 格式化会话大小：B → KB → MB（保留 1 位小数）。 */
    function fmtSize(bytes) {
      if (!bytes || bytes <= 0) return "0 B";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    /** 格式化会话统计副行：大小 · 轮数。 */
    function fmtStats(it) {
      const parts = [];
      if (it && typeof it.size === "number") parts.push(fmtSize(it.size));
      if (it && typeof it.turns === "number") parts.push(it.turns + " 轮");
      return parts.join(" · ");
    }

    /**
     * 空会话标签：turns 为 0 时返回「（空会话）工作区名」（工作区名 = cwd 的 basename，
     * 与官方 displayTitle fallback 一致），否则返回 null。
     */
    function emptySessionLabel(it) {
      if (!it || typeof it.turns !== "number" || it.turns !== 0) return null;
      const base = String(it.cwd || "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
      return "（空会话）" + (base && base !== "?" ? base : "未命名");
    }

    /** 标签编辑器：点选已有标签（避免手输错字符产生分裂标签）+ 输入新标签 + 管理（删除/重命名） */
    function TagEditor(props) {
      const { title, current, all, bySession, onSave, onClose, busy, onTagsChanged, run } = props;
      const [selected, setSelected] = React.useState([...(current || [])]);
      const [input, setInput] = React.useState("");
      const [manage, setManage] = React.useState(false);
      const toggle = (tag) => {
        setSelected((s) => (s.includes(tag) ? s.filter((t) => t !== tag) : [...s, tag]));
      };
      const addNew = () => {
        const tags = input.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
        if (tags.length === 0) return;
        setSelected((s) => [...new Set([...s, ...tags])]);
        setInput("");
      };
      const available = (all || []).filter((t) => !selected.includes(t));
      // 标签使用数统计
      const usage = {};
      for (const ts of Object.values(bySession || {})) {
        for (const t of ts || []) usage[t] = (usage[t] || 0) + 1;
      }
      const renameTag = (oldTag) => {
        const next = window.prompt("重命名标签「" + oldTag + "」为（留空取消；与已有标签同名 = 合并）：", oldTag);
        if (next === null) return;
        const target = next.trim();
        if (!target || target === oldTag) return;
        run("重命名标签", () => tools["tags.rename"](oldTag, target))
          .then(() => {
            setSelected((s) => (s.includes(oldTag) ? [...new Set([...s.filter((t) => t !== oldTag), target])] : s));
            onTagsChanged && onTagsChanged();
          });
      };
      const deleteTag = (tag) => {
        if (!window.confirm("删除标签「" + tag + "」？将从所有会话移除（会话本身不动）")) return;
        run("删除标签", () => tools["tags.remove"](tag))
          .then(() => {
            setSelected((s) => s.filter((t) => t !== tag));
            onTagsChanged && onTagsChanged();
          });
      };
      const chip = (text, onClick, prefix) => jsx("span", {
        key: text,
        onClick,
        title: "点击" + (prefix === "✕ " ? "移除" : "添加"),
        style: {
          display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: 12, cursor: "pointer", userSelect: "none",
          background: prefix === "✕ " ? "rgba(47,125,50,0.22)" : "rgba(80,120,255,0.18)",
          color: prefix === "✕ " ? "#7ecb83" : "#9db8ff",
          borderRadius: 10, padding: "2px 8px",
        },
        children: prefix + text,
      });
      return jsx("div", {
        style: { position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", padding: 12 },
        onClick: onClose,
        children: jsx("div", {
          style: { width: "min(520px, 94vw)", maxHeight: "78vh", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-1, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }, children: [
              jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: manage ? "🗑 管理标签" : "🏷 设置标签：" + (title || "") }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "✕" }),
            ] }),
            manage ? jsx("div", { style: { flex: 1, overflowY: "auto", marginBottom: 10 }, children: [
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "全部标签（含使用数），可重命名/删除：" }),
              Object.keys(usage).length === 0
                ? jsx("div", { style: { fontSize: 12, opacity: 0.5, padding: 8 }, children: "（还没有任何标签）" })
                : Object.keys(usage).sort((a, b) => usage[b] - usage[a]).map((t) => jsx("div", {
                    key: t,
                    style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 4px", borderBottom: "1px solid rgba(128,128,128,0.1)" },
                    children: [
                      jsx("span", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: t + "（" + usage[t] + " 个会话）" }),
                      jsx(P.Button, { size: "sm", disabled: busy, onClick: () => renameTag(t), children: "重命名" }),
                      jsx(P.Button, { size: "sm", disabled: busy, onClick: () => deleteTag(t), children: "删除" }),
                    ],
                  })),
            ] }) : jsx("div", { children: [
              jsx("div", { style: { display: "flex", gap: 6, marginBottom: 12 }, children: [
                jsx("input", {
                  value: input,
                  onChange: (e) => setInput(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") addNew(); },
                  placeholder: "输入新标签（多个用逗号分隔）",
                  style: { flex: 1, minWidth: 0, fontSize: 13, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none" },
                }),
                jsx(P.Button, { size: "sm", onClick: addNew, children: "添加" }),
              ] }),
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "已选（点击移除）：" }),
              jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }, children: selected.length === 0 ? jsx("span", { style: { fontSize: 12, opacity: 0.5 }, children: "（无）" }) : selected.map((t) => chip(t, () => toggle(t), "✕ ")) }),
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "已有标签（点击添加，无需手输）：" }),
              jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }, children: available.length === 0 ? jsx("span", { style: { fontSize: 12, opacity: 0.5 }, children: "（没有其他标签）" }) : available.map((t) => chip(t, () => toggle(t), "+ ")) }),
            ] }),
            jsx("div", { style: { display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }, children: [
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setManage(!manage), children: manage ? "← 返回选择" : "🗑 管理标签" }),
              jsx("div", { style: { display: "flex", gap: 6 }, children: [
                jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "取消" }),
                !manage && jsx(P.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => onSave(selected), children: "保存" }),
              ] }),
            ] }),
          ],
        }),
      });
    }

    /** 归档会话 Tab：查看/恢复/删除 dsh 官方归档的会话 */
    function ArchivedTab(props) {
      const { tools, unwrap, run, confirm, busy, currentId, openView, onCopy } = props;
      const [items, setItems] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [msg, setMsg] = React.useState("");

      const refresh = React.useCallback(() => {
        setLoading(true);
        tools["archived.list"]()
          .then((resp) => setItems(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: archived.list 失败", e))
          .finally(() => setLoading(false));
      }, [tools, unwrap]);
      React.useEffect(() => { refresh(); }, [refresh]);

      const row = (it) => {
        const isCurrent = it.sessionId === currentId;
        const title = emptySessionLabel(it) || it.title || "(无标题)";
        const short = it.sessionId.length > 40 ? it.sessionId.slice(0, 37) + "…" : it.sessionId;
        return jsx("div", {
          key: it.sessionId,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: (isCurrent ? "▶ " : "") + title }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "copy", textDecoration: "underline dotted rgba(128,128,128,0.4)", title: it.sessionId + "（点击复制完整 ID）" },
                onClick: (e) => onCopy && onCopy(it.sessionId, e),
                children: "📋 " + short + (it.cwd ? " · " + it.cwd : "") + (fmtStats(it) ? " · " + fmtStats(it) : ""),
              }),
            ] }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent,
              onClick: () => openView(it.sessionId),
              title: "查看会话内容（只读）",
              children: "👁 查看",
            }),
            jsx(P.Button, {
              size: "sm", disabled: isCurrent,
              onClick: () => confirm("恢复归档会话「" + title + "」？重启后左侧重新显示") && run("恢复", () => tools["archived.restore"](it.sessionId)).then(() => { refresh(); setTimeout(() => window.location.reload(), 900); }),
              children: "恢复",
            }),
            jsx(P.Button, {
              size: "sm", disabled: isCurrent,
              onClick: () => confirm("删除归档会话「" + title + "」？文件进回收站（可恢复），并从归档列表移除") && run("删除", () => tools["archived.delete"](it.sessionId)).then(refresh),
              children: "删除",
            }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "dsh 官方归档的会话（左侧隐藏，文件仍在 sessions 区）。恢复后重启显示；删除进回收站" }),
            jsx(P.Button, { size: "sm", onClick: refresh, children: "刷新" }),
          ] }),
          msg ? jsx("div", { style: { fontSize: 12, marginBottom: 6 }, children: msg }) : null,
          loading && items.length === 0
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : items.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有归档会话" })
              : items.map(row),
        ],
      });
    }

    /** 子目录管理 Tab */
    function SubdirsTab(props) {
      const { tools, unwrap, run, confirm, subdirs, refreshSubdirs, sessions, currentId, refreshSessions, wsList } = props;
      const [newName, setNewName] = React.useState("");
      const [menuFor, setMenuFor] = React.useState(null);
      const [moveMenuFor, setMoveMenuFor] = React.useState(null);
      const [sessMoveFor, setSessMoveFor] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});

      const create = () => {
        const name = newName.trim();
        if (!name) return;
        run("新建", () => tools["workspace.create"](name)).then(refreshSubdirs);
        setNewName("");
      };

      // 子目录内会话（cwd 以子目录为前缀）
      const sessionsIn = (d) => (sessions || []).filter((s) => s.cwd === d.path || s.cwd.startsWith(d.path + "/"));

      // 批量移动目标：仅注册工作区 + 未分组
      const moveTargets = [
        { type: "label", id: "lbl-ws", text: "工作区" },
        ...(wsList || []).map((w) => ({ id: w.path, label: w.path + (w.title && w.title !== w.path ? "（" + w.title + "）" : "") })),
        { type: "label", id: "lbl-ung", text: "未分组" },
        { id: "UNGROUPED", label: "移出工作区（未分组）" },
      ];

      const titleOf = (sid) => {
        // 无 list 数据，用 id 截断显示
        return sid.length > 40 ? sid.slice(0, 37) + "…" : sid;
      };

      const row = (d) => {
        const inside = sessionsIn(d);
        const isOpen = !!expanded[d.name];
        const delItems = [
          { id: "trash", label: "删除 + 会话一并进回收站", danger: true },
          { id: "reset", label: "删除，会话重设到工作区根", danger: true },
          { id: "only", label: "仅删目录（会话 cwd 悬空）", danger: true },
        ];
        return jsx("div", {
          key: d.name,
          style: { borderBottom: "1px solid rgba(128,128,128,0.12)" },
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", flexWrap: "wrap" }, children: [
              jsx("div", {
                style: { flex: 1, minWidth: 140, cursor: "pointer", overflow: "hidden" },
                onClick: () => setExpanded({ ...expanded, [d.name]: !isOpen }),
                children: [
                  jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: d.name }, children: (isOpen ? "▾ " : "▸ ") + d.name }),
                  jsx("div", { style: { fontSize: 11, opacity: 0.55 }, children: d.sessionCount + " 个会话 · 点击展开" }),
                ],
              }),
              jsx(P.Button, {
                size: "sm", disabled: !!menuFor || !!moveMenuFor,
                onClick: () => {
                  const n = window.prompt("新名称：", d.name);
                  if (n === null || n.trim() === "" || n.trim() === d.name) return;
                  run("重命名", () => tools["workspace.rename"](d.name, n.trim())).then(refreshSubdirs);
                },
                children: "重命名",
              }),
              jsx(P.Button, { size: "sm", disabled: !!menuFor || !!moveMenuFor, onClick: () => run("复制", () => tools["workspace.copy"](d.name)).then(refreshSubdirs), children: "复制" }),
              jsx(P.Menu, {
                portal: true,
                open: moveMenuFor === d.name,
                anchor: jsx(P.Button, { size: "sm", variant: "outline", disabled: !!menuFor, onClick: () => setMoveMenuFor(moveMenuFor === d.name ? null : d.name), children: "移动会话▾" }),
                items: moveTargets,
                onSelect: (id) => {
                  setMoveMenuFor(null);
                  if (id === "UNGROUPED") {
                    confirm("把「" + d.name + "」内的 " + inside.length + " 个会话全部移出工作区（未分组）？") &&
                      run("移出工作区", () => Promise.all(inside.map((x) => tools["sessions.detach"](x.sessionId)))).then(refreshSubdirs);
                    return;
                  }
                  confirm("把「" + d.name + "」内的 " + inside.length + " 个会话全部移动到 " + id + "？") &&
                    run("批量移动", () => tools["workspace.moveSessions"](d.name, id)).then(refreshSubdirs);
                },
                onClose: () => setMoveMenuFor(null),
              }),
              jsx(P.Menu, {
                portal: true,
                open: menuFor === d.name,
                anchor: jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setMenuFor(menuFor === d.name ? null : d.name), children: "删除▾" }),
                items: delItems,
                onSelect: (id) => {
                  setMenuFor(null);
                  const actionLabel = { trash: "目录及关联会话将移入回收站", reset: "目录删除，关联会话重设到工作区根", only: "仅删除目录（会话 cwd 可能悬空）" }[id];
                  confirm("删除子目录「" + d.name + "」？" + actionLabel + "（需重启完整生效）") &&
                    run("删除", () => tools["workspace.delete"](d.name, id)).then(refreshSubdirs);
                },
                onClose: () => setMenuFor(null),
              }),
            ] }),
            isOpen && jsx("div", { style: { padding: "2px 4px 6px 16px" }, children: [
              inside.length === 0
                ? jsx("div", { style: { opacity: 0.5, fontSize: 12, padding: "2px 0" }, children: "（没有会话）" })
                : inside.map((sess) => {
                    const isCurrent = sess.sessionId === currentId;
                    return jsx("div", {
                      key: sess.sessionId,
                      style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 0", flexWrap: "wrap" },
                      children: [
                        jsx("div", { style: { flex: 1, minWidth: 120, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: sess.sessionId }, children: (isCurrent ? "▶ " : "") + titleOf(sess.sessionId) }),
                        jsx(P.Button, {
                          size: "sm", disabled: isCurrent,
                          onClick: () => confirm("删除会话「" + sess.sessionId + "」？进回收站") && run("删除", () => tools["sessions.delete"](sess.sessionId)).then(refreshSessions),
                          children: "删除",
                        }),
                        jsx(P.Menu, {
                          portal: true,
                          open: sessMoveFor === sess.sessionId,
                          anchor: jsx(P.Button, { size: "sm", disabled: isCurrent, onClick: () => setSessMoveFor(sessMoveFor === sess.sessionId ? null : sess.sessionId), children: "移动▾" }),
                          items: moveTargets,
                          onSelect: (id) => {
                            setSessMoveFor(null);
                            if (id === "UNGROUPED") { run("移出工作区", () => tools["sessions.detach"](sess.sessionId)).then(refreshSessions); return; }
                            run("移动", () => tools["sessions.move"](id, sess.sessionId)).then(refreshSessions);
                          },
                          onClose: () => setSessMoveFor(null),
                        }),
                      ],
                    });
                  }),
            ] }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("input", {
              value: newName,
              onChange: (e) => setNewName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") create(); },
              placeholder: "新子目录名（/workspace 下）",
              style: { flex: 1, minWidth: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit" },
            }),
            jsx(P.Button, { size: "sm", variant: "primary", disabled: !newName.trim(), onClick: create, children: "新建" }),
            jsx(P.Button, { size: "sm", onClick: refreshSubdirs, children: "刷新" }),
          ] }),
          subdirs.length === 0
            ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "工作区根没有子目录" })
            : subdirs.map(row),
        ],
      });
    }

    /** 搜索状态持久化（面板关闭重开保留，模块级不随组件卸载重置） */
    let searchPersist = { kw: "", hits: [], searching: false, msg: "" };

    /** 自研搜索 Tab */
    function SearchTab(props) {
      const { tools, unwrap, list, openSession, onClose } = props;
      const [kw, setKw] = React.useState(searchPersist.kw);
      const [hits, setHits] = React.useState(searchPersist.hits);
      const [searching, setSearching] = React.useState(searchPersist.searching);
      const [msg, setMsg] = React.useState(searchPersist.msg);
      const abortRef = React.useRef(null);
      const skipPersist = React.useRef(false); // 「清除搜索」只清当前显示，跳过持久层同步（重开面板恢复）
      // 已点击的记录标记（本轮搜索内生效；新搜索/手动清除时重置）
      const [clicked, setClicked] = React.useState(searchPersist.clicked || {}); // 已点击标记（持久化：关面板重开后保留）
      const [semantic, setSemantic] = React.useState(false); // 语义搜索模式
      // 关键词时间范围过滤（搜索页内嵌：修改即保存，重新打开工具箱自动恢复）
      const [dateFromStr, setDateFromStr] = React.useState("");
      const [dateToStr, setDateToStr] = React.useState("");
      const [semCfg, setSemCfg] = React.useState({ enabled: false, minScore: 80, topN: 20 }); // 语义开关/阈值/条数（设置页配置）
      const [scope, setScope] = React.useState("visible"); // 当前显示分组：visible/archived/trash（切换纯前端，不重搜）
      const [groups, setGroups] = React.useState(() => {
        // 重开面板时从持久化结果重建分组（否则挂载后的同步 useEffect 会用空分组覆盖恢复的 hits）
        const g = { visible: [], archived: [], trash: [], subagent: [] };
        for (const h of searchPersist.hits || []) {
          const b = h.bucket || "visible";
          if (g[b]) g[b].push(h);
        }
        return g;
      }); // 一次搜索全部分组结果
      React.useEffect(() => {
        setHits(groups[scope] || []); // 切换标签/结果落地时同步当前显示
      }, [groups, scope]);
      const applyResults = (list) => {
        // 按 bucket 分组合并（断点续扫跨段累积）
        const g = { visible: [], archived: [], trash: [] };
        for (const h of list || []) {
          const b = h.bucket || "visible";
          if (g[b]) g[b].push(h);
        }
        setGroups((prev) => ({
          visible: mergeHits(prev.visible, g.visible),
          archived: mergeHits(prev.archived, g.archived),
          trash: mergeHits(prev.trash, g.trash),
        }));
      };
      const groupCount = () => (groups.visible ? groups.visible.length + groups.archived.length + groups.trash.length : 0);
      React.useEffect(() => {
        if (tools && typeof tools["config.get"] === "function") {
          tools["config.get"]()
            .then((resp) => {
              const d = unwrap(resp);
              if (!d) return;
              setDateFromStr(d.searchDateFrom || "");
              setDateToStr(d.searchDateTo || "");
              setSemCfg({ enabled: d.embedEnabled !== false, minScore: Number.isFinite(Number(d.embedMinScore)) ? d.embedMinScore : 80, topN: Number.isFinite(Number(d.embedTopN)) && Number(d.embedTopN) > 0 ? d.embedTopN : 0 });
            })
            .catch(() => {});
        }
      }, []);
      const setDateField = (key, value) => {
        if (key === "searchDateFrom") setDateFromStr(value);
        else setDateToStr(value);
        try { tools["config.set"](key, value).catch(() => {}); } catch {}
      };
      const fmtDT = (dt) => {
        const p = (n) => String(n).padStart(2, "0");
        return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + "T" + p(dt.getHours()) + ":" + p(dt.getMinutes());
      };
      const quickRange = (kind) => {
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
        let from = null, to = null;
        if (kind === "today") { from = new Date(y, m, d, 0, 0); to = new Date(y, m, d, 23, 59); }
        else if (kind === "yesterday") { const t = new Date(y, m, d - 1); from = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, 0); to = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59); }
        else if (kind === "month") { from = new Date(y, m, 1, 0, 0); to = new Date(y, m, d, 23, 59); }
        else if (kind === "lastMonth") { const lm = new Date(y, m - 1, 1); from = new Date(lm.getFullYear(), lm.getMonth(), 1, 0, 0); to = new Date(y, m, 0, 23, 59); }
        setDateField("searchDateFrom", from ? fmtDT(from) : "");
        setDateField("searchDateTo", to ? fmtDT(to) : "");
      };
      const rangeFromMs = () => {
        const t = dateFromStr ? new Date(String(dateFromStr).replace(" ", "T")).getTime() : 0;
        return Number.isFinite(t) && t > 0 ? t : 0;
      };
      const rangeToMs = () => {
        const t = dateToStr ? new Date(String(dateToStr).replace(" ", "T")).getTime() + 60000 : 0; // 结束时刻含该分钟
        return Number.isFinite(t) && t > 0 ? t : 0;
      };

      // 状态变化写回持久层（重开面板恢复）
      // 超时询问（partial 时提示继续/取消；「继续」用 forceFull 全量重搜）
      const [partialAsk, setPartialAsk] = React.useState(null);
      // 缓存倒计时
      const [cacheExpiresAt, setCacheExpiresAt] = React.useState(0);
      const [cacheLeft, setCacheLeft] = React.useState(null);
      React.useEffect(() => {
        if (!cacheExpiresAt) { setCacheLeft(null); return undefined; }
        const tick = () => {
          const left = Math.ceil((cacheExpiresAt - Date.now()) / 1000);
          if (left <= 0) { setCacheLeft(0); return; }
          setCacheLeft(left);
        };
        tick();
        const t = setInterval(tick, 1000);
        return () => clearInterval(t);
      }, [cacheExpiresAt]);
      const applyCache = (r) => {
        if (r && r.cache && typeof r.cache.expiresInMs === "number") setCacheExpiresAt(Date.now() + r.cache.expiresInMs);
      };

      React.useEffect(() => {
        if (skipPersist.current) { skipPersist.current = false; return; } // 清除搜索：保留持久层，重开面板恢复
        searchPersist.kw = kw;
        searchPersist.hits = hits;
        searchPersist.searching = searching;
        searchPersist.msg = msg;
        searchPersist.clicked = clicked;
      }, [kw, hits, searching, msg, clicked]);

      // 断点续扫结果合并（按 会话+seq/行 去重）
      const mergeHits = (prev, next) => {
        const seen = new Set((prev || []).map((h) => h.sessionId + ":" + (h.seq ?? h.line)));
        return [...(prev || []), ...(next || []).filter((h) => !seen.has(h.sessionId + ":" + (h.seq ?? h.line)))];
      };
      const doSearch = (fromIndex) => {
        const resume = Number(fromIndex) > 0; // 「继续搜索全部」= 从断点接着扫（每段仍 30 秒）
        const keyword = kw.trim();
        if (!keyword || searching) return;
        setClicked({}); // 新搜索清除点击标记
        setPartialAsk(null);
        setCacheExpiresAt(0); // 搜索开始清掉旧倒计时（结果出来后才重新显示）
        if (!resume) { setGroups({ visible: [], archived: [], trash: [], subagent: [] }); setMsg(""); } // 新搜索清空旧结果，避免结果未出时误点
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setSearching(true);
        setMsg("");
        if (semantic) {
          // 语义搜索：确保索引 → embedding 查询 → 失败降级关键词
          const doEmbed = () => {
            tools["search.embed"](keyword, ctrl.signal)
              .then((resp) => {
                const r = unwrap(resp);
                if (r && r.ok === false && r.fallback) {
                  // 降级：提示后走关键词搜索（返回 promise 让外层 finally 等搜索完成，期间保持"搜索中"）
                  setMsg("🧠 语义搜索不可用（" + ((r && r.error) || "未知") + "）→ 已降级为关键词搜索");
                  return tools["search.query"](keyword, resume ? fromIndex : 0, rangeFromMs(), rangeToMs(), ctrl.signal)
                    .then((resp2) => {
                      const r2 = unwrap(resp2);
                      applyCache(r2);
                      const arr = r2 && r2.hits ? r2.hits : [];
                      applyResults(arr);
                      if (r2 && r2.partial) setPartialAsk({ count: groupCount() + arr.length, scanned: r2.scanned || 0, total: r2.total || 0, memoryMB: r2.memoryMB || 0 });
                      else if (arr.length === 0 && !resume) setMsg("无命中");
                    })
                    .catch(() => {});
                }
                if (r && r.ok && r.hits) {
                  applyCache(r);
                  const arr = r.hits.map((h) => ({ sessionId: h.sessionId, seq: h.seq, score: h.score, semantic: true, snippet: h.snippet, bucket: h.bucket }));
                  applyResults(arr);
                  if (arr.length === 0) setMsg("语义无命中");
                  else setMsg("🧠 语义命中 " + arr.length + " 条（相关度阈值 " + semCfg.minScore + "% · 最多 " + (semCfg.topN > 0 ? semCfg.topN : "不限") + " 条 · 共索引 " + (r.total || "?") + " 条消息）");
                  return;
                }
                setMsg("语义搜索异常：" + ((r && r.error) || "未知"));
              })
              .catch((e) => {
                if (e && e.name !== "AbortError") setMsg("语义搜索失败：" + (e.message || String(e)));
              })
              .finally(() => { setSearching(false); abortRef.current = null; });
          };
          // 先确保索引
          tools["search.embedStatus"]()
            .then((resp) => {
              const st = unwrap(resp);
              if (st && st.total > 0) { doEmbed(); return; }
              return tools["search.embedBuild"]().then((resp2) => {
                const b = unwrap(resp2);
                if (b && b.ok === false && b.fallback) {
                  setMsg("🧠 语义搜索不可用（" + ((b && b.error) || "索引构建失败") + "）→ 已降级为关键词搜索");
                  return tools["search.query"](keyword, resume ? fromIndex : 0, rangeFromMs(), rangeToMs(), ctrl.signal)
                    .then((resp3) => {
                      const r3 = unwrap(resp3);
                      applyCache(r3);
                      const arr3 = (r3 && r3.hits) || [];
                      applyResults(arr3);
                      if (r3 && r3.partial) setPartialAsk({ count: groupCount() + arr3.length, scanned: r3.scanned || 0, total: r3.total || 0, memoryMB: r3.memoryMB || 0 });
                      else if (arr3.length === 0 && !resume) setMsg("无命中");
                    })
                    .catch(() => {});
                }
                setMsg("🧠 首次索引构建完成，开始语义搜索…");
                doEmbed();
              });
            })
            .catch((e) => { setMsg("索引状态失败：" + (e.message || String(e))); setSearching(false); abortRef.current = null; });
          return;
        }
        tools["search.query"](keyword, resume ? fromIndex : 0, rangeFromMs(), rangeToMs(), ctrl.signal)
          .then((resp) => {
            const r = unwrap(resp);
            applyCache(r);
            const arr = r && r.hits ? r.hits : [];
            applyResults(arr);
            if (r && r.partial) setPartialAsk({ count: groupCount() + arr.length, scanned: r.scanned || 0, total: r.total || 0, memoryMB: r.memoryMB || 0 });
            else if (arr.length === 0 && !resume) setMsg("无命中");
            if (r && r.usedOfficial === false && arr.length > 0) setMsg("🔍 命中 " + arr.length + " 条（自研搜索，内存占用高；建议开启「官方搜索开关」并重启，改用 SQLite 索引省内存）");
          })
          .catch((e) => {
            if (e && e.name !== "AbortError") setMsg("搜索失败：" + (e.message || String(e)));
          })
          .finally(() => {
            setSearching(false);
            abortRef.current = null;
          });
      };
      const cancel = () => {
        try { abortRef.current && abortRef.current.abort(); } catch {}
        setSearching(false);
      };

      const highlight = (text) => {
        const k = kw.trim().toLowerCase();
        const idx = String(text).toLowerCase().indexOf(k);
        if (idx < 0 || !k) return text;
        return jsx(React.Fragment, { children: [
          text.slice(0, idx),
          jsx("mark", { style: { background: "#f5c518", color: "#000", borderRadius: 2, padding: "0 1px" }, children: text.slice(idx, idx + k.length) }),
          text.slice(idx + k.length),
        ] });
      };

      const row = (h) => {
        const sum = list && list.byId ? list.byId[h.sessionId] : undefined;
        const title = (sum && sum.displayTitle) || h.sessionId.slice(0, 32);
        const hkey = h.sessionId + ":" + (h.seq ?? h.line);
        const isClicked = !!clicked[hkey];
        return jsx("div", {
          key: hkey,
          style: {
            padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)",
            cursor: "pointer", borderRadius: 4,
            borderLeft: isClicked ? "3px solid #4a8fd6" : "3px solid transparent",
            opacity: isClicked ? 0.55 : 1,
            background: isClicked ? "rgba(74,143,214,0.08)" : "transparent",
          },
          onClick: (e) => {
            e.preventDefault(); e.stopPropagation();
            setClicked({ ...clicked, [hkey]: true });
            if (onClose) { try { onClose(); } catch {} } // 先关面板露出会话区，再定位
            if (openSession) openSession(h.sessionId, kw, h.seq, !!h.semantic, h.snippet);
          },
          title: "点击打开会话并定位",
          children: [
            jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 2 }, children: title + (h.semantic ? " · 🎯 相关度 " + Math.round((h.score || 0) * 100) + "%" : (h.line ? " · 第 " + h.line + " 行" : "")) }),
            jsx("div", { style: { fontSize: 12, lineHeight: 1.5 }, children: h.semantic ? (h.snippet ? (String(h.snippet).length > 120 ? String(h.snippet).slice(0, 120) + "…" : h.snippet) : "（无内容预览，点击打开定位）") : highlight(h.snippet) }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx(P.Button, {
              size: "sm", variant: semantic ? "primary" : "outline",
              disabled: semCfg.enabled === false,
              onClick: () => setSemantic(!semantic),
              title: semCfg.enabled === false ? "语义搜索已关闭（设置 → 工具箱 → 🧠 语义搜索 开启开关）" : "语义搜索需要配置 Embedding API Key；无 Key/失败自动降级",
              children: semantic ? "🧠 语义" : "🔍 关键词",
            }),
            jsx("input", {
              value: kw,
              onChange: (e) => setKw(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") doSearch(); },
              placeholder: semantic ? "用语义搜索所有会话（如：那次部署配置的事）…" : "搜索所有会话内容…",
              style: { flex: 1, minWidth: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit" },
            }),
            searching
              ? jsx(P.Button, { size: "sm", variant: "outline", onClick: cancel, children: "取消" })
              : jsx(P.Button, { size: "sm", variant: "primary", disabled: !kw.trim(), onClick: doSearch, children: "搜索" }),
            Object.keys(clicked).length > 0 && jsx(P.Button, {
              size: "sm", variant: "outline",
              onClick: () => setClicked({}),
              title: "清除已点击记录的标记样式",
              children: "清除标记（" + Object.keys(clicked).length + "）",
            }),
            (kw.trim() || hits.length > 0) && jsx(P.Button, {
              size: "sm", variant: "outline",
              onClick: () => { skipPersist.current = true; setKw(""); setGroups({ visible: [], archived: [], trash: [] }); setHits([]); setMsg(""); setPartialAsk(null); setClicked({}); },
              title: "只清除当前显示的输入与结果（缓存/倒计时保留；误点后重开工具箱即恢复）",
              children: "🧹 清除搜索",
            }),
          ] }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" },
            children: [
              jsx("span", { style: { fontSize: 12, opacity: 0.7 }, children: "🔎 范围：" }),
              jsx(P.Button, { size: "sm", variant: scope === "visible" ? "primary" : "outline", onClick: () => setScope("visible"), title: "切换显示分组（结果已一次搜出，即时切换）", children: "可见会话" }),
              jsx(P.Button, { size: "sm", variant: scope === "archived" ? "primary" : "outline", onClick: () => setScope("archived"), title: "切换显示分组（结果已一次搜出，即时切换）", children: "归档会话" }),
              jsx(P.Button, { size: "sm", variant: scope === "trash" ? "primary" : "outline", onClick: () => setScope("trash"), title: "切换显示分组（结果已一次搜出，即时切换）", children: "回收站会话" }),
              jsx(P.Button, { size: "sm", variant: scope === "subagent" ? "primary" : "outline", onClick: () => setScope("subagent"), title: "切换显示分组（结果已一次搜出，即时切换）", children: "子代理会话" }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" },
            children: [
              jsx("span", { style: { fontSize: 12, opacity: 0.7 }, children: "🕐 时间范围：" }),
              jsx("input", {
                type: "datetime-local",
                value: dateFromStr,
                onChange: (e) => setDateField("searchDateFrom", e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
              jsx("span", { style: { fontSize: 12, opacity: 0.7 }, children: "~" }),
              jsx("input", {
                type: "datetime-local",
                value: dateToStr,
                onChange: (e) => setDateField("searchDateTo", e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => quickRange("today"), children: "今天" }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => quickRange("yesterday"), children: "昨天" }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => quickRange("month"), children: "本月" }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => quickRange("lastMonth"), children: "上月" }),
              (dateFromStr || dateToStr) && jsx(P.Button, { size: "sm", variant: "outline", onClick: () => quickRange("clear"), children: "清空" }),
            ],
          }),
          msg ? jsx("div", { style: { fontSize: 12, marginBottom: 6, opacity: 0.85 }, children: msg }) : null,
          cacheLeft != null ? jsx("div", { style: { fontSize: 12, marginBottom: 6, opacity: 0.7 }, children: cacheLeft > 0 ? ("⏱ 缓存倒计时：" + cacheLeft + "s" + (semantic ? "（同词搜索免 API 调用）" : "（同词搜索免解压）")) : "⏱ 缓存已过期（下次同词搜索将重新计算）" }) : null,
          partialAsk ? jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }, children: [
            jsx("span", { style: { fontSize: 12, opacity: 0.85 }, children: "⚠️ 本段搜索已超过 30 秒，已扫 " + partialAsk.scanned + "/" + (partialAsk.total || "?") + " 个会话，目前共找到 " + partialAsk.count + " 条。" + (partialAsk.memoryMB > 1500 ? "（当前内存 " + partialAsk.memoryMB + "MB，建议重启 DSH 服务释放内存；持续搜索可能更慢）" : "") }),
            jsx(P.Button, { size: "sm", variant: "primary", onClick: () => { setPartialAsk(null); doSearch(partialAsk.scanned); }, children: "⏩ 继续扫描（再 30 秒）" }),
            jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setPartialAsk(null), children: "✕ 取消（保留当前结果）" }),
            jsx(P.Button, { size: "sm", variant: "outline", onClick: () => { skipPersist.current = true; setKw(""); setGroups({ visible: [], archived: [], trash: [] }); setHits([]); setMsg(""); setPartialAsk(null); setClicked({}); }, children: "🧹 清除搜索（清空输入与结果）" }),
          ] }) : null,
          searching
            ? jsx("div", { style: { opacity: 0.6, padding: 12, fontSize: 13 }, children: [jsx("span", { className: "dsd-spin" }), "搜索中…（正在逐会话检索，会话多时较慢，可随时点「取消」停止）"] })
            : hits.map(row),
        ],
      });
    }

    function apply(ctx) {
      // ── 0. 长消息折叠引擎（纯渲染增强：超阈值行数的消息自动折叠，点击展开） ──
      // 设置存 window.__dsdCollapse（设置页改动即时同步，见 ToolsSettingsSection）
      window.__dsdCollapse = window.__dsdCollapse || { userOn: true, userThreshold: 15, aiOn: false };
      try {
        // 折叠样式（前缀 dsd- 防冲突）
        if (!document.getElementById("dsh-toolbox-collapse-css")) {
          const st = document.createElement("style");
          st.id = "dsh-toolbox-collapse-css";
          st.textContent = [
            ".dsd-fold { position: relative; }",
            ".dsd-fold.dsd-folded { max-height: var(--dsd-fold-h, 360px); overflow: hidden; }",
            ".dsd-fold.dsd-folded::after { content: \"\"; position: absolute; left: 0; right: 0; bottom: 0; height: 44px; background: linear-gradient(transparent, var(--dsw-alias-bg-layer-1, #1c1c20)); pointer-events: none; }",
            ".dsd-fold.dsd-open { max-height: none; overflow: visible; }",
            ".dsd-fold.dsd-open::after { display: none; }",
            ".dsd-fold-btn { position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); z-index: 5; font-size: 12px; cursor: pointer; user-select: none; border: none; border-radius: 999px; padding: 2px 12px; color: var(--dsw-alias-label-primary, #eee); background: var(--dsw-specific-button-secondary, rgba(128,128,128,0.4)); white-space: nowrap; }",
            ".dsd-fold-btn:hover { background: var(--dsw-specific-button-secondary-hover, rgba(128,128,128,0.6)); }",
            ".dsd-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(128,128,128,0.3); border-top-color: #9a9a9a; border-radius: 50%; animation: dsd-spin 0.8s linear infinite; vertical-align: -1px; margin-right: 6px; }",
            "@keyframes dsd-spin { to { transform: rotate(360deg); } }",
          ].join("\n");
          document.head.appendChild(st);
        }
        // 处理单个候选容器：超阈值 → 折叠 + 按钮；设置关闭 → 恢复展开（幂等）
        const foldTarget = (el) => {
          if (!el) return;
          const cfg = window.__dsdCollapse || {};
          const want = el.dataset.dsdKind === "ai" ? cfg.aiOn === true : cfg.userOn !== false;
          const threshold = Number(cfg.userThreshold) > 0 ? Number(cfg.userThreshold) : 15;
          if (!want || threshold <= 0) {
            if (el.dataset.dsdFold === "1") {
              el.classList.remove("dsd-fold", "dsd-folded", "dsd-open");
              const btn = el.querySelector(".dsd-fold-btn");
              if (btn) btn.remove();
              delete el.dataset.dsdFold;
            }
            return;
          }
          if (el.dataset.dsdFold === "1") return; // 已处理
          let lineH = 24;
          try { lineH = parseFloat(getComputedStyle(el).lineHeight) || 24; } catch {}
          const maxH = Math.round(threshold * lineH) + 24; // 阈值行高 + 余量
          let fullH = 0;
          try { fullH = el.scrollHeight; } catch { return; }
          if (fullH <= maxH) return; // 不够长，不折叠
          el.dataset.dsdFold = "1";
          el.classList.add("dsd-fold", "dsd-folded");
          el.style.setProperty("--dsd-fold-h", maxH + "px");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dsd-fold-btn";
          btn.textContent = "展开全部 ▾";
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            const open = el.classList.toggle("dsd-open");
            el.classList.toggle("dsd-folded", !open);
            btn.textContent = open ? "收起 ▴" : "展开全部 ▾";
          });
          el.appendChild(btn);
        };
        // 在新增子树里找候选：用户气泡（_userRow 内 _bubble）与 AI markdown（_markdown）
        const scan = (root) => {
          const cfg = window.__dsdCollapse || {};
          try {
            if (cfg.userOn !== false) {
              root.querySelectorAll('div[class*="_userRow"] div[class*="_bubble"]').forEach((el) => { el.dataset.dsdKind = "user"; foldTarget(el); });
            }
            if (cfg.aiOn === true) {
              root.querySelectorAll('div[class*="_markdown"]').forEach((el) => { el.dataset.dsdKind = "ai"; foldTarget(el); });
            }
          } catch {}
        };
        // 设置变化后重扫（设置页同步 window.__dsdCollapse 后调用）
        window.__dsdScan = () => { try { scan(document.body); } catch {} };
        // MutationObserver：监听消息列表变化（防抖）
        let scanTimer = null;
        const observer = new MutationObserver((muts) => {
          const cfg = window.__dsdCollapse || {};
          if (cfg.userOn === false && cfg.aiOn !== true) return;
          if (scanTimer) return; // 已在队列中
          scanTimer = setTimeout(() => {
            scanTimer = null;
            try {
              let any = false;
              for (const m of muts) {
                if (m.type !== "childList" || !m.addedNodes) continue;
                for (const n of m.addedNodes) {
                  if (n.nodeType !== 1) continue;
                  scan(n);
                  any = true;
                }
              }
              // 首次全量扫描一次（页面已有历史消息）
              if (!observer._dsdBoot) { observer._dsdBoot = true; scan(document.body); }
            } catch {}
          }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // 首次全量扫描（历史消息也折叠）
        setTimeout(() => { try { scan(document.body); } catch {} }, 800);
      } catch (e) {
        console.warn("dsh-toolbox: 折叠引擎启动失败", e);
      }

      // ── 0.5 设置页左侧分区导航可滚动（官方面板 overflow:hidden 无滚动条，插件多时分区被挤出点不到） ──
      // 官方 SettingsRoot 结构：panel(flex row, overflow:hidden) → nav(188px 固定列) → navList(分区按钮)；
      // 用 CSS Modules 后缀选择器（_nav/_panel/_navList）匹配，官方构建换哈希前缀也能命中。
      try {
        const fixSettingsNav = () => {
          const navs = document.querySelectorAll('nav[class$="_nav"]');
          for (const nav of navs) {
            const panel = nav.closest('[class$="_panel"]');
            if (!panel) continue; // 非设置面板内的 nav 不动
            if (!nav.querySelector('[class$="_navList"]')) continue;
            try { if (getComputedStyle(nav).overflowY === "auto") continue; } catch { continue; }
            nav.style.minHeight = "0";
            nav.style.overflowY = "auto";
            nav.style.overflowX = "hidden";
            nav.style.paddingBottom = "12px";
          }
        };
        window.__dsFixSettingsNav = fixSettingsNav;
        let navTimer = null;
        const navObserver = new MutationObserver(() => {
          if (navTimer) return;
          navTimer = setTimeout(() => {
            navTimer = null;
            try { fixSettingsNav(); } catch {}
          }, 300);
        });
        navObserver.observe(document.body, { childList: true, subtree: true });
        // 首查 + 兜底（设置面板可能在点击后才挂载，observer 会兜住；延迟再补一次）
        try { fixSettingsNav(); } catch {}
        setTimeout(() => { try { fixSettingsNav(); } catch {} }, 1200);
      } catch (e) {
        console.warn("dsh-toolbox: 设置导航滚动修复启动失败", e);
      }

      // ── 0.6 对话视图 Tag 收纳（conversation.view 的 tab 栏）：默认折叠、可展开/收起并记住，
      //      开关 collapseTagBar（默认开）关闭时按钮消失、tab 栏始终展开（不做任何干预） ──
      // 原理（官方结构）：conversation.view 的 tab 行 = [role="tablist"] > button[role="tab"]（含
      //      memory-evolve 等插件注册的标签）；"导出"按钮行 = 会话头部操作区（放收纳按钮）。
      try {
        const TB_KEY = "dsh-tb-tagbar"; // "1"=折叠（默认） "0"=展开
        const TB_PREFIX = "dsh-tb";
        const tagBarEnabled = () => window.__dshTagBarCfg !== false; // 设置开关（默认 true）
        const knownLabels = ["记忆", "技能", "待办", "设置", "模型", "同步", "书签", "Broadcast", "COI"];
        const findBar = () => {
          // 取含 ≥2 个已知标签且 tab 数 ≥3 的 tablist（对话区 conversation.view 的那条）
          const bars = [...document.querySelectorAll('[role="tablist"]')];
          for (const b of bars) {
            const txt = b.textContent || "";
            if (knownLabels.filter((k) => txt.includes(k)).length >= 2 && b.querySelectorAll('[role="tab"]').length >= 3) return b;
          }
          // 退化：tab 数最多的一条
          let best = null;
          for (const b of bars) { const n = b.querySelectorAll('[role="tab"]').length; if (n >= 3 && (!best || n > best._n)) { best = b; best._n = n; } }
          return best;
        };
        const ensureBtn = (bar, host) => {
          if (!host || document.getElementById(TB_PREFIX + "-btn")) return;
          const btn = document.createElement("button");
          btn.id = TB_PREFIX + "-btn";
          btn.type = "button";
          btn.title = "展开/收起对话视图标签（记忆/技能/待办/设置…）";
          btn.style.cssText = "margin-left:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid rgba(128,128,128,0.4);background:transparent;color:inherit;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;flex:none;";
          // 注意：官方 header/tablist 会随会话切换重渲染，这里必须实时查找当前 DOM，
          // 不能闭包绑定创建时的 bar（旧节点脱离文档后操作无效 = “只生效一次/点不动”）
          const sync = () => {
            const cur = findBar();
            const collapsed = localStorage.getItem(TB_KEY) !== "0";
            btn.textContent = collapsed ? "🗂 展开" : "🗂 收起";
            btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
            if (cur) cur.classList.toggle(TB_PREFIX + "-collapsed", collapsed);
          };
          btn.addEventListener("click", () => {
            try {
              localStorage.setItem(TB_KEY, localStorage.getItem(TB_KEY) === "0" ? "1" : "0");
              sync();
            } catch {}
          });
          host.appendChild(btn);
          return btn;
        };
        // 样式：折叠时整行隐藏
        if (!document.getElementById(TB_PREFIX + "-css")) {
          const st = document.createElement("style");
          st.id = TB_PREFIX + "-css";
          st.textContent = `.${TB_PREFIX}-collapsed { display: none !important; }`;
          document.head.appendChild(st);
        }
        const applyTagBar = () => {
          try {
            if (!tagBarEnabled()) {
              // 开关关闭：移除按钮 + 不折叠（恢复 tab 栏原样）
              const b = document.getElementById(TB_PREFIX + "-btn");
              if (b) b.remove();
              const bar = findBar();
              if (bar) bar.classList.remove(TB_PREFIX + "-collapsed");
              return;
            }
            const bar = findBar();
            if (!bar) return;
            // 按钮挂点：优先「导出」按钮父行；dsh-pocket 会把「导出」挪出会话头部（PC/移动均可能）→
            // 找不到时直接挂到标签栏行内（tablist 尾部），与导出按钮彻底解耦
            const exp = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("导出"));
            let host = exp ? exp.parentElement : null;
            if (!host) host = bar;
            const btn = ensureBtn(bar, host);
            if (btn) {
              const cur = findBar();
              const collapsed = localStorage.getItem(TB_KEY) !== "0";
              btn.textContent = collapsed ? "🗂 展开" : "🗂 收起";
              btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
              if (cur) cur.classList.toggle(TB_PREFIX + "-collapsed", collapsed);
            }
          } catch {}
        };
        window.__dsdTagBarApply = applyTagBar;
        applyTagBar();
        setTimeout(applyTagBar, 800);
        setTimeout(applyTagBar, 2000);
        const tbObs = new MutationObserver(() => { try { applyTagBar(); } catch {} });
        tbObs.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        console.warn("dsh-toolbox: Tag 收纳启动失败", e);
      }

      // ── 1. 注册后端端点（生成 ctx.remote.dshToolbox.* 调用方法） ──
      ctx.remote.$mount({ package: "dsh-toolbox", descriptors: DESCRIPTORS }).then(() => {
        // ── 2. 设置分组（设置 → 工具箱）：$mount 完成后再注册，组件能拿到 tools
        // namespace 服务 key = "remote.dsh-toolbox"（remoteServiceKey = `remote.${namespace}`）
        const tools = ctx.get("remote.dsh-toolbox");
        console.log("dsh-toolbox: $mount 完成 | tools =", typeof tools, "| tools 键 =", tools ? Object.keys(tools).slice(0, 6).join(",") : "无");
        const unwrap = (resp) => (resp && typeof resp === "object" && resp.ok === true && resp.value !== undefined ? resp.value : resp);
        // 初始化折叠设置（页面加载即用真实配置；设置页改动由 ToolsSettingsSection 同步）
        try {
          if (tools && typeof tools["config.get"] === "function") {
            tools["config.get"]().then((resp) => {
              const d = unwrap(resp) || {};
              window.__dsdCollapse = window.__dsdCollapse || {};
              window.__dsdCollapse.userOn = d.collapseUserMsg !== false;
              window.__dsdCollapse.userThreshold = Number(d.collapseUserThreshold) > 0 ? Number(d.collapseUserThreshold) : 15;
              window.__dsdCollapse.aiOn = d.collapseAiMsg === true;
              window.__dshTagBarCfg = d.collapseTagBar !== false;
              if (typeof window.__dsdTagBarApply === "function") setTimeout(window.__dsdTagBarApply, 50);
              if (typeof window.__dsdScan === "function") setTimeout(window.__dsdScan, 100);
            }).catch(() => {});
          }
        } catch (e) { console.warn("dsh-toolbox: 折叠设置初始化失败", e); }
        // 打开会话（官方 sessions 服务）；带 keyword/seq 时定位到关键词所在消息
        const openSession = (sessionId, keyword, seq, semantic, snippet) => {
          try {
            const svc = ctx.get("sessions");
            if (svc && typeof svc.open === "function") svc.open(sessionId);
            else { console.warn("dsh-toolbox: sessions 服务不可用", sessionId); return; }
          } catch (e) {
            console.error("dsh-toolbox: openSession 失败", sessionId, e);
            return;
          }
          const kwText = typeof keyword === "string" ? keyword.trim() : "";
          if (kwText.length < 2 && seq == null) return;
          const flash = (el) => {
            if (!el) return;
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            const prev = el.style.background;
            el.style.background = "rgba(245,197,24,0.35)";
            setTimeout(() => { el.style.background = prev; }, 2500);
          };
          const scrollContainer = () => {
            let best = null, bestH = 0;
            for (const s of document.querySelectorAll("main, [class*='conversation'], [class*='scroll'], [class*='message']")) {
              if (s.scrollHeight > bestH) { best = s; bestH = s.scrollHeight; }
            }
            return best;
          };
          const findTextEls = (needle) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const matches = [];
            let node;
            while ((node = walker.nextNode())) {
              // 跳过工具箱面板自身（面板里也渲染命中文本，会误闪/误滚到面板）
              if (node.parentElement && node.parentElement.closest("[data-dsh-toolbox-overlay]")) continue;
              const t = node.textContent || "";
              if (needle && t.includes(needle)) matches.push(node.parentElement);
            }
            return matches;
          };
          const tryLocate = () => {
            // 1) 官方消息 DOM 若有 data-seq 属性则直接命中
            if (seq != null) {
              const el = document.querySelector('[data-seq="' + seq + '"]');
              if (el) { flash(el); return; }
            }
            // 2) 语义命中：snippet 已由后端按需解压附带（搜索词是语义描述，文本不一定匹配）
            if (seq != null && semantic) {
              const needle = snippet ? String(snippet).slice(0, 60) : "";
              if (!needle) return;
              // 逐轮滚动探测：底部（最新）→ 顶部（历史）→ 中部，每轮等虚拟滚动渲染
              const probe = (round) => {
                const ms = findTextEls(needle);
                if (ms.length > 0) { flash(ms[0]); return; }
                if (round >= 7) return;
                const box = scrollContainer();
                if (!box) return;
                box.scrollTop = round === 0 ? box.scrollHeight : (round >= 5 ? box.scrollHeight / 2 : 0);
                // 底部 2s → 顶部 4 段各 3s（首次加载 + 「加载更多」历史渲染共 12s 窗口）→ 中部 2s
                setTimeout(() => probe(round + 1), round === 0 ? 2000 : (round <= 4 ? 3000 : 2000));
              };
              probe(0);
              return;
            }
            // 3) 关键词/降级路径：用命中消息的内容片段（snippet）探测定位（比搜索词更精确，支持旧消息）
            const needle = snippet ? String(snippet).slice(0, 60) : kwText;
            if (!needle) return;
            const probe = (round) => {
              const ms = findTextEls(needle);
              if (ms.length > 0) { flash(ms[0]); return; }
              if (round >= 7) return;
              const box = scrollContainer();
              if (!box) return;
              box.scrollTop = round === 0 ? box.scrollHeight : (round >= 5 ? box.scrollHeight / 2 : 0);
              // 底部 2s → 顶部 4 段各 3s（首次加载 + 「加载更多」历史渲染共 12s 窗口）→ 中部 2s
              setTimeout(() => probe(round + 1), round === 0 ? 2000 : (round <= 4 ? 3000 : 2000));
            };
            probe(0);
          };
          setTimeout(tryLocate, 1500); // 首次打开会话 dsh 渲染需要时间
        };
        // 官方分叉复制：store 感知左侧立即可见；fork 后自定义命名为「原标题-副本x」
        const forkSession = (sessionId) => {
          const svc = ctx.get("sessions");
          if (!svc || typeof svc.fork !== "function") throw new Error("sessions 服务不可用");
          return svc.fork({ sessionId }).then(async (childId) => {
            // 复制后不跳转：仅创建副本，保持当前会话不变
            try {
              const snap = svc.list ? svc.list.getSnapshot() : undefined;
              const src = snap && snap.byId ? snap.byId[sessionId] : undefined;
              const srcTitle = (src && (src.title || src.displayTitle)) || "未命名会话";
              const existing = new Set(Object.values(snap?.byId || {}).map((s) => s.displayTitle));
              let n = 1;
              while (existing.has(srcTitle + "-副本" + n)) n += 1;
              const child = svc.binding ? svc.binding(childId)?.session : undefined;
              if (child && typeof child.rename === "function") {
                const r = await child.rename(srcTitle + "-副本" + n);
                if (!r || !r.ok) console.warn("dsh-toolbox: 副本重命名失败", r && r.error);
              }
            } catch (e) {
              console.warn("dsh-toolbox: 副本命名跳过", e);
            }
            return childId;
          });
        };

        // 工具箱面板状态（挂到模块级变量，按钮与面板共享）
        let panelOpen = false;
        const panelState = { open: false, listeners: new Set() };
        const setPanelOpen = (v) => {
          panelState.open = v;
          panelState.listeners.forEach((fn) => fn(v));
        };
        const usePanelOpen = () => {
          const [open, setOpen] = React.useState(panelState.open);
          React.useEffect(() => {
            panelState.listeners.add(setOpen);
            return () => panelState.listeners.delete(setOpen);
          }, []);
          return open;
        };

        // 按钮完全对齐「导入会话」(dsh-chat-import) 的实现——其注释明确：视觉逐项对齐侧边栏
        //「设置」按钮（行高 22px、padding 6px 2px 6px 10px、gap 8px、圆角 12px、16×16 图标、
        // 颜色/悬停用侧边栏同一 CSS 变量 --dsw-alias-label-primary / interactive-bg-hover，
        // 明暗主题下与设置按钮一致）；rail（抽屉窄栏）态对齐同列图标按钮：36×36 圆钮。
        // rowFree 三态：行容器共享行（flex:1 1 auto/width:auto 自动排列）；column/wrap
        // 容器（其它插件改纵排）→ flex:0 0 auto + width:100% 占满宽。
        // 移动端适配：≤560px 让两个按钮上下排列（各占整行）。关键：注入 wrap 的对象必须是
        //「真正的 footer 行容器」，跳过官方 slot 的 display:contents 包装层（之前直接
        // parentElement 拿到 contents 层、wrap 无效、而 width:100% 在行内撑爆顶掉别的按钮）。
        if (!document.getElementById("dsh-toolbox-btn-css")) {
          const st = document.createElement("style");
          st.id = "dsh-toolbox-btn-css";
          // 移动端：按钮 rail 化——36×36 圆钮、隐藏文字，与「设置/导入会话」图标按钮一致；
          // 宽度/高度/圆角/居中全部覆盖，文字 span 隐藏，只留 🧰 图标
          st.textContent = "@media (max-width: 560px) { #dsh-toolbox-side-btn { width: 36px !important; height: 36px !important; border-radius: 50% !important; padding: 0 !important; justify-content: center !important; gap: 0 !important; flex: 0 0 auto !important; } #dsh-toolbox-side-btn .dsh-toolbox-btn-text { display: none !important; } }";
          document.head.appendChild(st);
        }
        const realFooterHost = (el) => {
          let n = el && el.parentElement;
          while (n && window.getComputedStyle(n).display === "contents") n = n.parentElement;
          return n;
        };
        const mobileStack = () => {
          try {
            const btn = document.getElementById("dsh-toolbox-side-btn");
            const host = realFooterHost(btn);
            if (!host) return;
            const mq = window.matchMedia("(max-width: 560px)");
            const apply = () => { try { host.style.flexWrap = mq.matches ? "wrap" : ""; } catch {} };
            apply();
            if (typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
          } catch {}
        };
        setTimeout(mobileStack, 800);
        setTimeout(mobileStack, 2500);
        const ToolboxButton = (p) => {
          const rail = !!(p && p.rail);
          const open = usePanelOpen();
          // 行容器检测（对齐 chat-import layout 判定）：父容器 row 方向且未 wrap → 行内共享
          const [rowFree, setRowFree] = React.useState(true);
          React.useEffect(() => {
            const probe = () => {
              try {
                const el = document.getElementById("dsh-toolbox-side-btn");
                const host = realFooterHost(el);
                if (!host) return;
                const cs = window.getComputedStyle(host);
                setRowFree(cs.flexDirection.startsWith("row") && cs.flexWrap !== "wrap");
              } catch {}
            };
            probe();
            const t = setTimeout(probe, 300);
            const el = document.getElementById("dsh-toolbox-side-btn");
            const host = realFooterHost(el);
            let ro;
            if (host) {
              ro = new ResizeObserver(probe);
              ro.observe(host);
            }
            return () => { if (ro) ro.disconnect(); clearTimeout(t); };
          }, []);
          const baseStyle = {
            boxSizing: "border-box", display: "flex", alignItems: "center",
            justifyContent: rail ? "center" : undefined,
            gap: rail ? "0" : "8px",
            background: "transparent", border: "none",
            color: "var(--dsw-alias-label-primary)",
            borderRadius: rail ? "50%" : "12px", padding: rail ? "0" : "6px 2px 6px 10px",
            fontSize: "14px", lineHeight: "22px", fontWeight: 400, cursor: "pointer",
          };
          const style = rail
            ? { ...baseStyle, flex: "0 0 auto", width: 36, height: 36, whiteSpace: "nowrap" }
            : rowFree
              ? { ...baseStyle, flex: "1 1 auto", width: "auto", minWidth: 0, whiteSpace: "nowrap" }
              : { ...baseStyle, flex: "0 0 auto", width: "100%", whiteSpace: "nowrap" };
          const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
          return jsx("button", {
            id: "dsh-toolbox-side-btn",
            type: "button",
            style,
            title: "工具箱：会话管理 / 回收站 / 子目录 / 搜索",
            "aria-label": "工具箱",
            onClick: () => setPanelOpen(!open),
            onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
            children: [
              jsx("span", { style: { flex: "none", fontSize: 16, lineHeight: 1 }, children: "🧰" }),
              !rail && jsx("span", { className: "dsh-toolbox-btn-text", style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: "工具箱" }),
            ],
          });
        };
        const ToolboxPanelHost = (slotProps) => {
          const open = usePanelOpen();
          return open
            ? jsx(ToolboxPanel, { tools, unwrap, useSessions: slotProps.useSessions, useWorkspaces: slotProps.useWorkspaces, openSession, forkSession, open, onClose: () => setPanelOpen(false) })
            : null;
        };

        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "dsh-toolbox",
              order: 5,
            },
            ToolboxButton,
          ),
        );
        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "dsh-toolbox-panel",
              order: 6,
            },
            ToolboxPanelHost,
          ),
        );
        const ToolsSection = () => jsx(ToolsSettingsSection, { tools });
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-toolbox",
              order: 100,
              label: () => "工具箱",
            },
            ToolsSection,
          ),
        );
        // 设置页「预设编辑」分组：自定义 agent（~/.agent-presets）在线编辑入口
        // 动态显隐：presetEdit 开关关闭 → 整个分组（含标题）移除；开启 → 恢复。
        // 轮询放 apply 层而非组件内（组件随条目移除被卸载，轮询必须独立存活）。
        const PresetsSection = () => jsx(PresetsTab, { tools, unwrap, run: undefined });
        let presetsDisposer = null;
        const registerPresets = () => {
          if (presetsDisposer) return;
          presetsDisposer = ctx.slots.register(
            { name: "settings.section", id: "dsh-toolbox-presets", order: 110, label: () => "预设编辑" },
            PresetsSection,
          );
        };
        const unregisterPresets = () => {
          if (presetsDisposer) { presetsDisposer(); presetsDisposer = null; }
        };
        // 设置页左侧「预设编辑」分区：默认隐藏（保留代码备用，不删除）。
        // 原因：插件多了之后，设置页左侧多出该分区会把其他插件条目顶出可视区。
        // 预设编辑入口仍保留：工具箱弹窗「预设」tab + 「预设编辑」开关。
        // 如需恢复显示：取消下面 registerPresets() 与轮询的注释即可。
        // registerPresets(); // 默认显示 → 已改为默认隐藏
        let lastPresetOn = null;
        const pollPresets = () => {
          tools["config.get"]()
            .then((resp) => {
              const on = (unwrap(resp) || {}).presetEdit !== false;
              if (on === lastPresetOn) return;
              lastPresetOn = on;
              if (on) registerPresets(); else unregisterPresets();
            })
            .catch(() => {});
        };
        // 轮询已断开：分区默认隐藏，不再随开关状态注册到设置页左侧。
        // 如需恢复：把下面一行取消注释。
        // const presetsTimer = setInterval(pollPresets, 2000);
        // 如需恢复轮询：取消上方注释并把下面是 clearInterval 一并恢复。
        ctx.on("dispose", () => { unregisterPresets(); });
      }).catch((err) => {
        console.error("dsh-toolbox: remote 挂载失败，工具箱不可用", err);
      });
    }

    return { apply, inject: ["remote", "slots", "settingsScope", "connection"] };
  },
});
