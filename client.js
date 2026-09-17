/**
 * dsh-approval-gate — 自动审批审查界面（浏览器端 bundle）
 *
 * 提供两处 UI（严格按 DSH 设计语言，--dsw-alias-* tokens）：
 * 1. ✅ 自动放行提示条：conversation.input.dock（输入框上方独立行，order=30，
 *    排在 todo/goal/queue 之下；无事件时完全隐藏不占位；不随流式对话滚动）
 * 2. 「审批」历史视图：conversation.view（order=20，chat=0/trajectory=10 →
 *    tab 显示在「轨迹」右侧），展示当前会话所有自动放行的动作时间线
 *    （命令、原因、涉及文件、判定路径、时间）
 *
 * 数据源：轮询 host 提供的 GET /api/auto-approve/events?sessionId=&since=
 * （events.jsonl 由 host 插件在每次自动放行时追加）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS = `
.ag-notice{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}
.ag-notice-card{box-sizing:border-box;display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:6px 10px 6px 12px;box-shadow:var(--dsw-shadow-lv1)}
.ag-notice-card-pending{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.ag-notice-card-manual{border-color:var(--dsw-alias-state-warn-primary)}
.ag-notice-card-reject{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-notice-actions{flex:none;display:flex;align-items:center;gap:6px}
.ag-notice-btn{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:12px;align-items:center;padding:0 10px;font-size:12px;line-height:22px;display:inline-flex;white-space:nowrap}
.ag-notice-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ag-notice-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.ag-notice-glyph{color:var(--dsw-alias-state-success-primary);flex:none;display:inline-flex;align-items:center;justify-content:center}
.ag-notice-glyph-warn{color:var(--dsw-alias-state-warn-label);flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:16px;width:16px;height:16px}
.ag-notice-glyph-err{color:var(--dsw-alias-state-error-primary);flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:16px;width:16px;height:16px}
.ag-notice-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.ag-notice-head{display:flex;align-items:center;gap:8px;min-width:0}
.ag-notice-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ag-notice-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ag-notice-meta{display:flex;align-items:center;gap:8px}
.ag-tag{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-tag-neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ag-tag-warn{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-tag-err{box-sizing:border-box;flex:none;height:18px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-time{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.ag-notice-close{width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0}
.ag-notice-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ag-view{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);position:relative}
.ag-view::after{content:"";pointer-events:none;position:absolute;left:0;right:0;bottom:0;height:32px;z-index:3;background:linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-layer-1) 0%, transparent) 0px, var(--dsw-alias-bg-layer-1) 32px)}
.ag-view-head{box-sizing:border-box;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 14px 8px;display:flex;flex-direction:column;gap:2px}
.ag-view-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.ag-view-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ag-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 14px 48px;display:flex;flex-direction:column;gap:2px}
.ag-row{box-sizing:border-box;display:flex;gap:10px;padding:9px 10px;border-radius:10px;transition:background .1s ease}
.ag-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ag-row-rail{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:2px}
.ag-row-glyph{color:var(--dsw-alias-state-success-primary);flex:none;display:inline-flex}
.ag-row-glyph-warn{color:var(--dsw-alias-state-warn-label);flex:none;display:inline-flex;font-size:12px;line-height:16px;width:14px;height:14px;align-items:center;justify-content:center}
.ag-row-glyph-err{color:var(--dsw-alias-state-error-primary);flex:none;display:inline-flex;font-size:12px;line-height:16px;width:14px;height:14px;align-items:center;justify-content:center}
.ag-row-line{flex:1 1 auto;flex:none;width:1px;background:var(--dsw-alias-border-l1);min-height:10px}
.ag-row:last-child .ag-row-line{display:none}
.ag-row-actions{display:flex;align-items:center;gap:6px;margin-top:2px}
.ag-row-pending{border-left:2px solid var(--dsw-alias-state-error-primary)}
.ag-row-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.ag-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.ag-row-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}
.ag-row-reason{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all;white-space:pre-wrap}
.ag-row-files{display:flex;flex-wrap:wrap;gap:4px}
.ag-file-chip{box-sizing:border-box;max-width:260px;height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;align-items:center;padding:0 7px;font:11px/18px var(--ds-font-family-code);display:inline-flex;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ag-empty{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ag-loading{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px}
.ag-mono{font-family:var(--ds-font-family-code)}
.ag-set{box-sizing:border-box;width:100%;max-width:720px;padding:0 0 28px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.ag-set-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.ag-set-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.ag-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.ag-set-card-head{flex-direction:column;gap:4px;display:flex}
.ag-set-card-title{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;font-size:14px;font-weight:500;line-height:20px;display:flex}
.ag-set-stage{box-sizing:border-box;flex:none;height:20px;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);border-radius:10px;align-items:center;padding:0 8px;font-size:11px;font-weight:500;line-height:20px;display:inline-flex;letter-spacing:.02em}
.ag-set-card-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.ag-set-note{color:var(--dsw-alias-state-warn-label);margin:0;font-size:13px;line-height:20px}
.ag-set-ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:13px;line-height:20px}
.ag-set-err{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}
.ag-set-row{flex-wrap:wrap;gap:8px;display:flex}
.ag-set-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:32px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 10px;font-size:13px;line-height:20px;font-family:var(--ds-font-family-code)}
.ag-set-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.ag-set-input::placeholder{color:var(--dsw-alias-label-caption)}
.ag-set-input-num{width:96px}
.ag-set-btn{box-sizing:border-box;height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:16px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex;white-space:nowrap}
.ag-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ag-set-btn:disabled{opacity:.4;cursor:default}
.ag-set-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.ag-set-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ag-set-btn-danger{color:var(--dsw-alias-state-error-primary)}
.ag-set-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-set-list{flex-direction:column;gap:6px;display:flex}
.ag-set-item{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;align-items:center;gap:8px;padding:6px 10px;min-width:0;display:flex}
.ag-set-item-label{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);word-break:break-all}
.ag-set-item-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.ag-set-item-del{flex:none;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:0}
.ag-set-item-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ag-set-empty{color:var(--dsw-alias-label-caption);margin:0;font-size:13px;line-height:20px;padding:4px 2px}
.ag-set-tag{box-sizing:border-box;flex:none;height:18px;border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em}
.ag-set-tag-blue{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ag-set-tag-green{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.ag-set-tag-gray{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ag-set-tag-red{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-set-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;display:grid}
.ag-set-hc{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;color:var(--dsw-alias-label-secondary);align-items:center;justify-content:center;gap:6px;height:30px;font-size:12px;line-height:18px;display:inline-flex}
.ag-set-learn{flex-direction:column;gap:8px;display:flex}
.ag-set-learn-item{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;align-items:center;gap:8px;padding:6px 10px;min-width:0;display:flex}
.ag-set-learn-info{flex:1 1 auto;min-width:0;flex-direction:column;gap:2px;display:flex}
.ag-set-learn-key{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);word-break:break-all}
.ag-set-learn-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.ag-set-learn-stop{flex:none;height:24px;color:var(--dsw-alias-state-error-primary);cursor:pointer;font:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;align-items:center;padding:0 10px;font-size:12px;line-height:24px;display:inline-flex;white-space:nowrap}
.ag-set-learn-stop:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.ag-diff-overlay{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.ag-diff-panel{box-sizing:border-box;width:min(760px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}
.ag-diff-head{box-sizing:border-box;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.ag-diff-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;display:flex;align-items:center;gap:8px}
.ag-diff-path{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);word-break:break-all}
.ag-diff-stats{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ag-diff-stats-add{color:var(--dsw-alias-state-success-primary)}
.ag-diff-stats-del{color:var(--dsw-alias-state-error-primary)}
.ag-diff-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px}
.ag-diff-line{box-sizing:border-box;display:flex;gap:8px;padding:1px 8px;white-space:pre-wrap;word-break:break-all;min-width:0}
.ag-diff-line-add{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-label-primary)}
.ag-diff-line-del{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ag-diff-line-ctx{background:transparent;color:var(--dsw-alias-label-secondary)}
.ag-diff-line-add .ag-diff-marker{color:var(--dsw-alias-state-success-primary)}
.ag-diff-line-del .ag-diff-marker{color:var(--dsw-alias-state-error-primary)}
.ag-diff-line-ctx .ag-diff-marker{color:var(--dsw-alias-label-tertiary)}
.ag-diff-marker{flex:none;width:16px;user-select:none}
.ag-diff-line-no{flex:none;width:52px;color:var(--dsw-alias-label-caption);text-align:right;user-select:none;font-variant-numeric:tabular-nums}
.ag-diff-text{flex:1 1 auto;min-width:0}
.ag-diff-hunk-sep{box-sizing:border-box;flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:2px 8px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:2px 0;user-select:none}
.ag-diff-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:16px;text-align:center}
.ag-diff-foot{box-sizing:border-box;flex:none;border-top:1px solid var(--dsw-alias-border-l2);padding:10px 14px;display:flex;align-items:center;gap:8px;justify-content:flex-end}
.ag-file-chip-snap{cursor:pointer;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.ag-file-chip-snap:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ag-snap-bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex-wrap:wrap}
.ag-snap-bar b{color:var(--dsw-alias-label-secondary);font-weight:500}
.ag-snap-bar-spacer{flex:1 1 auto}
`

    const VERDICT_LABELS = {
      rule: '白名单规则',
      'flash-safe': 'Flash 判定安全',
      learned: '沉淀规则',
      fpHit: '已确认操作',
      'flash-same': 'Flash 同类验证'
    }
    const VERDICT_NEUTRAL = new Set(['rule', 'learned', 'fpHit', 'flash-same'])
    /**
     * 生效的硬风险类别。默认值与 host 的 DEFAULT_HARD_CATEGORIES 一致，但 host 会通过
     * 事件 API 下发**实际配置**（hardCategories 是可在设置页改、且参与多机同步的键）。
     * 硬编码默认值会在用户自定义后撒谎：多显示追认按钮 → 点了 400；少显示 → 用户
     * 以为不可追认。因此以服务端下发的列表为准。
     */
    const DEFAULT_HARD_CATEGORIES = ['deletion', 'credential', 'remote', 'system', 'bulk']
    let HARD_CATEGORIES = new Set(DEFAULT_HARD_CATEGORIES)

    // 拒绝记录文案：按 host 记录的 path（判定路径）精确分类
    function rejectLabel(ev) {
      const p = ev && ev.path
      if (p === 'hard-category') return '人工拒绝（硬风险类别，本就永久人工）'
      if (p === 'unknown-category') return '人工拒绝（协议外类别，不升级）'
      if (p === 'deny-rule') return '人工拒绝（永久人工规则命中）'
      if (p === 'neutral-reject' || (ev && ev.category === 'neutral')) return '人工拒绝 · 已升级永久人工'
      // 兜底：旧事件无 path——按 category 兼容
      if (ev && HARD_CATEGORIES.has(ev.category)) return '人工拒绝（硬风险类别，本就永久人工）'
      return '人工拒绝'
    }

    // 静默拒绝文案：判定层未弹窗，直接拒绝让 agent 改方案
    function silentRejectLabel(ev) {
      const p = ev && ev.path
      if (p === 'hard-deny') return '已直接拒绝 · 凭据外泄或系统路径销毁'
      if (p === 'judge-unavailable') return '已直接拒绝 · 判定器不可用（连续失败）'
      if (p === 'classifier-deny') return '已直接拒绝 · 判定为有害或越权'
      return '已直接拒绝'
    }

    /**
     * 追认后的文案：原事件**仍是那次拒绝**（审计事实不改写，`path` 保留拒绝原因），
     * 但用户已追认 → 该操作**已放行**。因此措辞与配色都从「被拒」翻转为「已解决」，
     * 不再计为待处理拒绝；「曾直接拒绝」留在括号里，不隐瞒历史。
     */
    function reconsideredLabel(ev) {
      const p = ev && ev.path
      if (p === 'judge-unavailable') return '已追认放行 · 判定器不可用（曾直接拒绝）'
      if (p === 'classifier-deny') return '已追认放行 · 判定为有害或越权（曾直接拒绝）'
      return '已追认放行 · 曾直接拒绝'
    }

    function fmtTime(iso) {
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      } catch (e) { return String(iso || '') }
    }

    function GlyphCheck() {
      return React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        React.createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'var(--dsw-alias-state-success-tertiary)' }),
        React.createElement('path', { d: 'M5 8.3L7.1 10.4L11 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function resolveFrame(sp) {
      let sessionId = (sp && sp.sessionId) || null
      try {
        if (!sessionId && sp && typeof sp.useSessions === 'function') {
          const state = sp.useSessions(function (s) { return s })
          sessionId = (state && state.current) || null
        }
      } catch (e) {}
      return { sessionId }
    }

    /** 用 host 下发的生效硬类别刷新本地缓存（缺失/非法时保留当前值，不退回默认） */
    function applyHardCategories(list) {
      if (!Array.isArray(list) || list.length === 0) return
      HARD_CATEGORIES = new Set(list.map(function (c) { return String(c) }))
    }

    function fetchEvents(sessionId, since) {
      const q = '/api/auto-approve/events?sessionId=' + encodeURIComponent(sessionId || '') + (since ? '&since=' + since : '')
      return fetch(q, { headers: { 'cache-control': 'no-cache' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      }).then(function (data) {
        applyHardCategories(data && data.hardCategories)
        return (data && Array.isArray(data.events)) ? data.events : []
      })
    }

    // ================= ✅ 自动放行提示条（conversation.input.dock，order=30） =================
    /**
     * 已读位置（跨刷新保留）：静默拒绝的提示条会**一直挂在对话框上方**，直到用户
     * 切到「审批」tab 看过为止。已读集合与「当前仍待处理的最大事件 id」都放在
     * localStorage，刷新页面不会把待处理记录弄丢，也不会重复提醒已看过的记录。
     */
    const SEEN_REJECTS_KEY = 'dsh-approval-gate.seenRejects'
    const PENDING_REJECT_KEY = 'dsh-approval-gate.pendingReject'

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch (e) { return fallback }
    }
    function writeJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch (e) {}
    }

    /** 事件是否属于「需要用户知晓」的拒绝：静默拒绝 + 人工拒绝 */
    function isRejectEvent(ev) {
      const kind = ev && ev.kind
      return kind === 'hard-reject' || kind === 'judge-deny' || kind === 'manual-rejected'
    }

    /** 该事件能否被追认（与 host 端围栏一致：判定层静默拒绝 + 非硬风险类别） */
    function isReconsiderable(ev) {
      // 已追认（reconsidered）的记录不再给按钮：终态已翻转为「已放行」，再点就是重复追认
      return Boolean(ev) && ev.kind === 'judge-deny' && !ev.reconsidered
        && !HARD_CATEGORIES.has(String(ev.category || 'neutral'))
    }

    /**
     * 未读拒绝数（用于「审批」tab 角标）。事件从新到旧传入；遇到第一条已读记录即停止，
     * 因为「已读」是按切到审批 tab 的时刻整体推进的。
     */
    function countUnseenRejects(events) {
      const seen = new Set(readJson(SEEN_REJECTS_KEY, []))
      let n = 0
      for (const ev of events) {
        if (!isRejectEvent(ev)) continue
        if (seen.has(ev.id)) break
        n++
      }
      return n
    }

    /** 把当前所有拒绝事件标记为已读（用户切到审批 tab 时调用） */
    function markRejectsSeen(events) {
      const seen = readJson(SEEN_REJECTS_KEY, [])
      const set = new Set(seen)
      let changed = false
      for (const ev of events) {
        if (isRejectEvent(ev) && !set.has(ev.id)) { set.add(ev.id); changed = true }
      }
      if (changed) writeJson(SEEN_REJECTS_KEY, Array.from(set).slice(-500))
      return changed
    }

    /** 会话内广播「拒绝已读」，让 tab 角标与提示条同步（同页多个组件不共享 React 状态） */
    const SEEN_EVENT = 'dsh-approval-gate:rejects-seen'
    function broadcastSeen() {
      try { window.dispatchEvent(new CustomEvent(SEEN_EVENT)) } catch (e) {}
    }

    /** 轮询某个会话的全部审批事件（按 id 升序） */
    function fetchAllEvents(sessionId) {
      return fetchEvents(sessionId, 0)
    }

    /**
     * 切到「审批」tab。
     *
     * conversation.input.dock 的 slot props 里没有 openView（那是 conversation.session
     * 才有的注入面），所以这里按 DOM 找宿主渲染的 tab 按钮并点击——tab 的可见文本就是
     * 本插件注册的 label「审批」。找不到就返回 false，调用方退化为「标记已读 + 收起提示条」。
     */
    function clickApprovalTab() {
      try {
        const nodes = document.querySelectorAll('[role="tab"], button, [role="button"]')
        for (const node of nodes) {
          const text = String((node.textContent || '')).trim()
          // label 可能是「审批」或带角标的「审批 2」；排除本插件自己的按钮文案
          if (text === '审批' || /^审批\s*\d*$/.test(text)) {
            node.click()
            return true
          }
        }
      } catch (e) {}
      return false
    }

    function NoticeStrip(props) {
      const frame = resolveFrame(props.slotsProps || {})
      const sessionId = frame.sessionId
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const sinceRef = React.useRef(0)
      const lastShownIdRef = React.useRef(0) // 已弹过的事件最大 id（跨会话全局递增，防重复弹历史）
      const hideTimerRef = React.useRef(null)

      const openApprovalTab = function () {
        if (clickApprovalTab()) return
        // 兜底：切不动视图时至少把待处理记录标为已读，避免角标永久挂着
        fetchAllEvents(sessionId).then(function (evs) {
          markRejectsSeen(evs)
          broadcastSeen()
          setNotice(null)
        }).catch(function () {})
      }

      const doReconsider = function (ev) {
        setBusy(true)
        fetch('/api/auto-approve/reconsider', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, eventId: ev.id }),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) {
            // 已追认：标为已读并收起提示条
            const seen = readJson(SEEN_REJECTS_KEY, [])
            const set = new Set(seen); set.add(ev.id)
            writeJson(SEEN_REJECTS_KEY, Array.from(set).slice(-500))
            broadcastSeen()
            setNotice(null)
          } else {
            window.alert((res && res.error) || '追认失败')
          }
        }).catch(function (e) {
          window.alert('追认失败：' + String((e && e.message) || e))
        }).finally(function () { setBusy(false) })
      }

      React.useEffect(function () {
        let alive = true
        let timer = null
        sinceRef.current = 0
        setNotice(null)
        if (!sessionId) return

        // 待处理拒绝的恢复：刷新页面后仍要看到「直接拒绝」的提示条（用户没看过就不该消失）。
        // 只恢复最近一条，避免历史拒绝刷屏。已追认的不算待处理（终态已翻转为已放行），不恢复。
        const restorePending = function (evs) {
          const seen = new Set(readJson(SEEN_REJECTS_KEY, []))
          const pending = evs.filter(function (ev) { return isRejectEvent(ev) && !ev.reconsidered && !seen.has(ev.id) })
          if (pending.length > 0) {
            const last = pending[pending.length - 1]
            setNotice(last)
            lastShownIdRef.current = Math.max(lastShownIdRef.current, last.id)
          }
        }

        // 轮询主体：拉取游标之后的新事件；去重兜底（id 不大于已弹过的最大 id 直接跳过）
        const startPolling = function () {
          if (!alive) return
          timer = setInterval(function () {
            fetchEvents(sessionId, sinceRef.current).then(function (evs) {
              if (!alive) return
              if (evs.length === 0) return
              const last = evs[evs.length - 1]
              if (!last || last.id <= lastShownIdRef.current) return
              lastShownIdRef.current = last.id
              sinceRef.current = last.id
              const kind = last.kind || 'auto'
              setNotice(last)
              if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
              // 静默拒绝 / 人工拒绝：不自动收起，一直挂到用户看过「审批」tab 或点了处理按钮；
              // 等待人工审批（pending）同样不收起；其余（自动放行等）按类型定时收起。
              if (kind !== 'manual-pending' && !isRejectEvent(last)) {
                const hold = kind === 'manual-approved' ? 5000 : 4000
                hideTimerRef.current = setTimeout(function () { setNotice(null) }, hold)
              }
            }).catch(function () {})
          }, 2000)
        }

        // 打开会话：先静默拉一次全量，恢复未读拒绝 + 推进游标，不弹自动放行的历史记录
        fetchAllEvents(sessionId).then(function (evs) {
          if (!alive) return
          if (evs.length > 0) sinceRef.current = evs[evs.length - 1].id
          restorePending(evs)
          startPolling()
        }).catch(function () {
          if (!alive) return
          startPolling()
        })

        // 用户在「审批」tab 里看过之后，收起提示条
        const onSeen = function () {
          setNotice(function (cur) {
            if (cur && isRejectEvent(cur)) {
              const seen = new Set(readJson(SEEN_REJECTS_KEY, []))
              if (seen.has(cur.id)) return null
            }
            return cur
          })
        }
        window.addEventListener(SEEN_EVENT, onSeen)

        return function () {
          alive = false
          if (timer) clearInterval(timer)
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
          window.removeEventListener(SEEN_EVENT, onSeen)
        }
      }, [sessionId])

      if (!notice) return null
      const kind = notice.kind || 'auto'
      const isPending = kind === 'manual-pending'
      const isSilentReject = kind === 'hard-reject' || kind === 'judge-deny'
      const isManual = kind === 'manual-approved' || kind === 'manual-rejected'
      const isReject = isRejectEvent(notice)
      // 文案
      let title = ''
      let tagText = ''
      let glyph = null
      if (isPending) {
        title = '等待人工审批：' + (notice.justification || notice.reason || '')
        tagText = '人工审批中'
        glyph = React.createElement('span', { className: 'ag-notice-glyph-warn' }, '◔')
      } else if (isSilentReject) {
        // 已被追认（可能在另一个窗口点的）：状态已翻转为「已放行」，不该再吓人
        const done = Boolean(notice.reconsidered)
        title = (done ? '已追认放行：' : '已直接拒绝：') + (notice.justification || notice.reason || '')
        tagText = done ? reconsideredLabel(notice) : silentRejectLabel(notice)
        glyph = React.createElement('span', { className: done ? 'ag-notice-glyph' : 'ag-notice-glyph-err' }, done ? '✓' : '✕')
      } else if (kind === 'manual-approved') {
        const lc = notice.learningCount !== undefined ? notice.learningCount : null
        const th = notice.threshold || 3
        title = '人工审批通过：' + (notice.justification || notice.reason || '')
        tagText = lc !== null ? ('学习 ' + lc + '/' + th + '，满 ' + th + ' 次后自动放行') : '人工审批通过'
        glyph = React.createElement('span', { className: 'ag-notice-glyph-warn' }, '✓')
      } else if (kind === 'manual-rejected') {
        title = '已拒绝：' + (notice.justification || notice.reason || '')
        tagText = rejectLabel(notice).replace('人工拒绝', '已拒绝')
        glyph = React.createElement('span', { className: 'ag-notice-glyph-err' }, '✕')
      } else {
        title = (notice.justification || notice.reason || '')
        const label = VERDICT_LABELS[notice.verdict] || notice.verdict || '自动放行'
        tagText = '自动放行 · ' + label
        glyph = React.createElement(GlyphCheck, null)
      }
      const cardCls = 'ag-notice-card'
        + (isPending ? ' ag-notice-card-pending' : isManual ? ' ag-notice-card-manual' : '')
        // 追认过的静默拒绝不再是「错误状态」：去掉红色告警底，回到中性卡片
        + (isReject && !notice.reconsidered ? ' ag-notice-card-reject' : '')
      // 拒绝类提示条：不自动消失，提供「查看审批记录」与（可追认时）「重新审批通过」
      const canReconsider = isReconsiderable(notice)
      return React.createElement('div', { className: 'ag-notice' },
        React.createElement('div', { className: cardCls },
          React.createElement('span', { className: 'ag-notice-glyph' }, glyph),
          React.createElement('div', { className: 'ag-notice-body' },
            React.createElement('div', { className: 'ag-notice-head' },
              React.createElement('span', { className: 'ag-notice-tool' }, notice.tool || 'tool'),
              React.createElement('span', { className: 'ag-notice-text' }, title),
            ),
            React.createElement('div', { className: 'ag-notice-meta' },
              React.createElement('span', { className: isPending ? 'ag-tag-warn' : (kind === 'manual-rejected' || (isSilentReject && !notice.reconsidered)) ? 'ag-tag-err' : (kind === 'manual-approved' || notice.reconsidered) ? 'ag-tag-warn' : 'ag-tag' + (VERDICT_NEUTRAL.has(notice.verdict) ? ' ag-tag-neutral' : '') }, tagText),
              React.createElement('span', { className: 'ag-time' }, fmtTime(notice.ts)),
              isReject && !notice.reconsidered
                ? React.createElement('span', { className: 'ag-notice-hint' }, '未读 · 切到「审批」tab 后自动收起')
                : null,
            ),
          ),
          isReject
            ? React.createElement('div', { className: 'ag-notice-actions' },
                canReconsider
                  ? React.createElement('button', {
                      type: 'button', className: 'ag-notice-btn', disabled: busy,
                      title: '追认这次拒绝：写入自动放行规则，并让 AI 重试该操作',
                      onClick: function () { doReconsider(notice) },
                    }, busy ? '处理中…' : '重新审批通过')
                  : null,
                React.createElement('button', {
                  type: 'button', className: 'ag-notice-btn',
                  title: '打开「审批」tab 查看全部记录',
                  onClick: openApprovalTab,
                }, '查看审批记录'),
              )
            : null,
          React.createElement('button', {
            type: 'button',
            className: 'ag-notice-close',
            title: '关闭提示',
            'aria-label': '关闭提示',
            onClick: function () { setNotice(null) },
          }, '✕'),
        ),
      )
    }

    // ================= diff 面板（审批记录文件改动查看 + 撤销） =================
    function fmtBytes(n) {
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    }

    function DiffPanel(props) {
      const sessionId = props.sessionId
      const eventId = props.eventId
      const path = props.path
      const onClose = props.onClose
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [revertMsg, setRevertMsg] = React.useState(null)
      const [reverting, setReverting] = React.useState(false)
      const [revertDone, setRevertDone] = React.useState(false)

      React.useEffect(function () {
        setData(null)
        setError(null)
        setRevertDone(false)
        fetch('/api/auto-approve/diff?eventId=' + eventId + '&path=' + encodeURIComponent(path), { headers: { 'cache-control': 'no-cache' } })
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (res && res.ok) setData(res)
            else setError((res && res.error) || '加载 diff 失败')
          })
          .catch(function (e) { setError('加载 diff 失败：' + String((e && e.message) || e)) })
      }, [eventId, path])

      const doRevert = function () {
        // 防重复：同一事件只允许投递一次撤销指令（v0.5.0 事故中同一 event 被重复撤销 4 次）
        if (reverting || revertDone) return
        setReverting(true)
        setRevertMsg(null)
        fetch('/api/auto-approve/revert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, eventId: eventId }),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) {
            setRevertMsg('撤销指令已发送到对话框，AI 将按指令恢复文件')
            setRevertDone(true)
          } else {
            setRevertMsg((res && res.error) || '发送失败')
          }
        }).catch(function (e) {
          setRevertMsg('发送失败：' + String((e && e.message) || e))
        }).finally(function () {
          setReverting(false)
        })
      }

      const changedLines = data ? (data.changedLines || []) : []
      const hunks = data && Array.isArray(data.hunks) ? data.hunks : null
      const stats = data ? (data.stats || {}) : null

      return React.createElement('div', { className: 'ag-diff-overlay', onClick: function (e) { if (e.target === e.currentTarget) onClose() } },
        React.createElement('div', { className: 'ag-diff-panel' },
          React.createElement('div', { className: 'ag-diff-head' },
            React.createElement('div', { className: 'ag-diff-title' },
              React.createElement('span', null, '文件改动对比'),
              React.createElement('button', { type: 'button', className: 'ag-notice-close', title: '关闭', 'aria-label': '关闭', onClick: onClose }, '✕'),
            ),
            React.createElement('div', { className: 'ag-diff-path' }, path),
            stats
              ? React.createElement('div', { className: 'ag-diff-stats' },
                  React.createElement('span', { className: 'ag-diff-stats-add' }, '+' + stats.added),
                  ' / ',
                  React.createElement('span', { className: 'ag-diff-stats-del' }, '-' + stats.removed),
                  ' 行变更 · ' + stats.contextLines + ' 行未变' + (data.afterExists === false ? '（文件当前已不存在）' : ''),
                )
              : null,
          ),
          React.createElement('div', { className: 'ag-diff-body' },
            error
              ? React.createElement('div', { className: 'ag-diff-empty' }, error)
              : !data
                ? React.createElement('div', { className: 'ag-diff-empty' }, '加载中…')
                : hunks
                  ? hunks.map(function (h, hi) {
                      return React.createElement('div', { key: 'hunk' + hi },
                        h.hiddenBefore > 0
                          ? React.createElement('div', { className: 'ag-diff-hunk-sep' }, h.hiddenBefore + ' unmodified lines')
                          : null,
                        h.lines.map(function (c, i) {
                          const isAdd = c.type === 'add'
                          const isDel = c.type === 'del'
                          const cls = isAdd ? 'ag-diff-line-add' : (isDel ? 'ag-diff-line-del' : 'ag-diff-line-ctx')
                          const marker = isAdd ? '+' : (isDel ? '-' : ' ')
                          const aNo = c.aNo != null ? String(c.aNo) : ''
                          const bNo = c.bNo != null ? String(c.bNo) : ''
                          return React.createElement('div', { className: 'ag-diff-line ' + cls, key: 'hl' + i },
                            React.createElement('span', { className: 'ag-diff-marker' }, marker),
                            React.createElement('span', { className: 'ag-diff-line-no' }, aNo + (aNo && bNo ? ' ' : '') + bNo),
                            React.createElement('span', { className: 'ag-diff-text' }, c.text),
                          )
                        }),
                      )
                    })
                  : changedLines.length === 0
                    ? React.createElement('div', { className: 'ag-diff-empty' }, '该文件无内容变化（或文件不可读）')
                    : changedLines.map(function (c, i) {
                        return React.createElement('div', {
                          className: 'ag-diff-line ' + (c.type === 'add' ? 'ag-diff-line-add' : 'ag-diff-line-del'),
                          key: i,
                        },
                          React.createElement('span', { className: 'ag-diff-marker' }, c.type === 'add' ? '+' : '-'),
                          React.createElement('span', { className: 'ag-diff-line-no' }, String(c.line)),
                          React.createElement('span', { className: 'ag-diff-text' }, c.text),
                        )
                      }),
          ),
          React.createElement('div', { className: 'ag-diff-foot' },
            revertMsg
              ? React.createElement('span', { className: revertMsg.indexOf('已发送') === 0 ? 'ag-set-ok' : 'ag-set-err' }, revertMsg)
              : null,
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn ag-set-btn-primary',
              onClick: doRevert,
              disabled: reverting || revertDone,
            }, reverting ? '发送中…' : (revertDone ? '已发送撤销指令' : '撤销此改动')),
            React.createElement('button', { type: 'button', className: 'ag-set-btn', onClick: onClose }, '关闭'),
          ),
        ),
      )
    }

    // ================= 审批历史视图（conversation.view，order=20，轨迹右侧） =================
    function HistoryView(props) {
      const sessionId = (props && (props.sessionId || (props.slotsProps && props.slotsProps.sessionId))) || null
      const [events, setEvents] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [snapStats, setSnapStats] = React.useState(null) // {count, bytes} | null
      const [snapIds, setSnapIds] = React.useState(null) // Set<eventId> | null（当前存在快照的事件）
      const [snapFiles, setSnapFiles] = React.useState(null) // {eventId: [absPath,...]} | null（文件级 diff 可点击判断）
      const [diffOpen, setDiffOpen] = React.useState(null) // {eventId, path} | null
      const [busyId, setBusyId] = React.useState(null) // 正在追认的事件 id
      const [feedback, setFeedback] = React.useState(null)
      const aliveRef = React.useRef(true)

      /** 拉取本会话全部审批事件（时间倒序）；组件卸载后丢弃结果 */
      const loadEvents = function () {
        if (!sessionId) { setEvents([]); return Promise.resolve() }
        return fetchEvents(sessionId, 0).then(function (evs) {
          if (!aliveRef.current) return
          evs.sort(function (a, b) { return b.id - a.id }) // 时间倒序：最新在最上面
          setEvents(evs)
          setError(null)
          // 打开「审批」tab = 用户看过这些拒绝：标记已读，提示条与待处理角标据此收起
          if (markRejectsSeen(evs)) broadcastSeen()
        }).catch(function (e) {
          if (!aliveRef.current) return
          setError(String((e && e.message) || e))
        })
      }

      /** 追认一次静默拒绝：写规则 + 让 AI 重试；成功后重新加载列表 */
      const doReconsider = function (ev) {
        if (busyId !== null) return
        setBusyId(ev.id)
        setFeedback(null)
        fetch('/api/auto-approve/reconsider', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, eventId: ev.id }),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) {
            setFeedback({ ok: true, msg: '已追认：写入自动放行规则' + (res.duplicate ? '（规则已存在）' : '') + '，并已通知 AI 重试该操作' })
            // 标记已读并通知提示条收起
            const seen = new Set(readJson(SEEN_REJECTS_KEY, [])); seen.add(ev.id)
            writeJson(SEEN_REJECTS_KEY, Array.from(seen).slice(-500))
            broadcastSeen()
            loadEvents()
          } else {
            setFeedback({ ok: false, msg: (res && res.error) || '追认失败' })
          }
        }).catch(function (e) {
          setFeedback({ ok: false, msg: '追认失败：' + String((e && e.message) || e) })
        }).finally(function () { setBusyId(null) })
      }

      const loadSnapStats = function (sid) {
        const q = sid ? ('?sessionId=' + encodeURIComponent(sid)) : ''
        fetch('/api/auto-approve/snapshots-stats' + q, { headers: { 'cache-control': 'no-cache' } })
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (!res || !res.ok) return
            setSnapStats({ count: res.count || 0, bytes: res.bytes || 0 })
            setSnapIds(new Set((res.ids || []).map(String)))
            // 文件级映射：eventId → 该事件有快照的文件绝对路径列表
            const fm = {}
            if (res.files && typeof res.files === 'object') {
              for (const k of Object.keys(res.files)) {
                const arr = Array.isArray(res.files[k]) ? res.files[k] : []
                if (arr.length > 0) fm[k] = arr.map(String)
              }
            }
            setSnapFiles(fm)
          })
          .catch(function () {})
      }

      // 清除快照：mode='session' 仅本会话（默认），mode='all' 清全部（含其他会话，需二次确认）
      const doClearSnapshots = function (mode) {
        const sid = mode === 'session' ? sessionId : ''
        const msg = mode === 'all'
          ? '确定清除【全部会话】的 diff 快照？这可能删除其他会话还没看过的改动对比记录，且不可恢复。'
          : '确定清除【本会话】的 diff 快照？仅删除本会话审批产生的改动对比数据，不影响审批记录本身。'
        if (!window.confirm(msg)) return
        const body = {}
        if (sid) body.sessionId = sid
        fetch('/api/auto-approve/snapshots-clear', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) {
            if (mode === 'all') { setSnapStats({ count: 0, bytes: 0 }); setSnapIds(new Set()); setSnapFiles({}) }
            else loadSnapStats(sessionId)
          }
        }).catch(function () {})
      }

      React.useEffect(function () {
        aliveRef.current = true
        setEvents(null)
        setError(null)
        loadSnapStats(sessionId)
        if (!sessionId) { setEvents([]); return }
        loadEvents()
        const timer = setInterval(function () { loadEvents(); loadSnapStats(sessionId) }, 5000)
        // 提示条点了「重新审批通过」后广播已读，这里同步刷新
        const onSeen = function () { loadEvents() }
        window.addEventListener(SEEN_EVENT, onSeen)
        return function () {
          aliveRef.current = false
          clearInterval(timer)
          window.removeEventListener(SEEN_EVENT, onSeen)
        }
      }, [sessionId])

      // 待处理拒绝数：已拒绝但尚未追认的记录（硬拒档也算，它只能靠人工重做，但至少看得见）
      const pendingRejects = (events || []).filter(function (ev) {
        return isRejectEvent(ev) && !ev.reconsidered
      })

      return React.createElement('div', { className: 'ag-view' },
        React.createElement('div', { className: 'ag-view-head' },
          React.createElement('div', { className: 'ag-view-title' },
            '自动放行审批',
            pendingRejects.length > 0
              ? React.createElement('span', { className: 'ag-tag-err', style: { marginLeft: 8 } }, '待处理 ' + pendingRejects.length)
              : null,
          ),
          React.createElement('div', { className: 'ag-view-sub' }, '本会话中自动放行与人工审批的记录（最新在上）'),
          React.createElement('div', { className: 'ag-view-sub' },
            '被拒绝的记录可点「重新审批通过」追认：写入自动放行规则并让 AI 重试该操作（硬拒档与硬风险类别除外）。'),
        ),
        feedback
          ? React.createElement('div', { className: feedback.ok ? 'ag-set-ok' : 'ag-set-err', style: { padding: '6px 14px 0' } }, feedback.msg)
          : null,
        React.createElement('div', { className: 'ag-snap-bar' },
          React.createElement('span', null,
            'diff 快照 ',
            React.createElement('b', null, snapStats ? (fmtBytes(snapStats.bytes) + ' · ' + snapStats.count + ' 条') : '…'),
          ),
          React.createElement('span', { className: 'ag-snap-bar-spacer' }),
          React.createElement('button', {
            type: 'button',
            className: 'ag-set-btn',
            onClick: function () { doClearSnapshots('session') },
            disabled: !snapStats || snapStats.count === 0,
            title: '仅清除本会话的 diff 快照（不影响其他会话）',
          }, '仅清本会话'),
          React.createElement('button', {
            type: 'button',
            className: 'ag-set-btn ag-set-btn-danger',
            onClick: function () { doClearSnapshots('all') },
            disabled: !snapStats || snapStats.count === 0,
            title: '清空全部会话（含其他会话未查看过的）diff 快照，需二次确认',
          }, '清空全部'),
        ),
        events === null
          ? React.createElement('div', { className: 'ag-loading' }, '加载中…')
          : events.length === 0
            ? React.createElement('div', { className: 'ag-empty' }, error ? ('加载失败：' + error) : '本会话暂无审批记录')
            : React.createElement('div', { className: 'ag-list' },
                events.map(function (ev) {
                  const kind = ev.kind || 'auto'
                  // pending（等待中）不在视图展示终态记录（提示条负责）
                  if (kind === 'manual-pending') return null
                  const files = Array.isArray(ev.files) ? ev.files : []
                  // 文件级快照判断：事件有快照 且 该文件在快照文件列表中
                  // （ev.files 可能是相对/带 ~ 路径，快照 files 是绝对路径 → basename 匹配兜底）
                  const snapPaths = (snapFiles && snapFiles[String(ev.id)]) || []
                  const snapPathSet = new Set(snapPaths)
                  const snapBaseSet = new Set(snapPaths.map(function (p) { return String(p).split('/').pop() }))
                  const hasSnap = function (f) {
                    if (snapIds === null || !snapIds.has(String(ev.id))) return false
                    if (snapPathSet.has(String(f))) return true
                    const base = String(f).split('/').pop()
                    return base && snapBaseSet.has(base)
                  }
                  let tagText = ''
                  let tagCls = 'ag-tag'
                  let glyph = React.createElement(GlyphCheck, null)
                  let glyphCls = 'ag-row-glyph'
                  const canReconsider = isReconsiderable(ev)
                  if (kind === 'manual-approved') {
                    const lc = ev.learningCount !== undefined ? ev.learningCount : null
                    const th = ev.threshold || 3
                    tagText = lc !== null ? ('人工通过 · 学习 ' + lc + '/' + th + '（满 ' + th + ' 次自动放行）') : '人工通过'
                    tagCls = 'ag-tag-warn'
                    glyphCls = 'ag-row-glyph-warn'
                    glyph = React.createElement('span', null, '✓')
                  } else if (kind === 'manual-rejected' || kind === 'hard-reject' || kind === 'judge-deny') {
                    // 按拒绝路径精确分类文案（reason 由 host 记录）
                    // hard-reject / judge-deny 是判定层静默拒绝（未弹窗）
                    const silent = kind === 'hard-reject' || kind === 'judge-deny'
                    if (ev.reconsidered && silent) {
                      // 追认已把终态翻转为「已放行」：文案与配色一起改，不再算待处理拒绝；
                      // 原拒绝事实不隐瞒，收在括号里（「曾直接拒绝」）。
                      tagText = reconsideredLabel(ev)
                      tagCls = 'ag-tag-warn'
                      glyphCls = 'ag-row-glyph-warn'
                      glyph = React.createElement('span', null, '✓')
                    } else {
                      tagText = silent ? silentRejectLabel(ev) : rejectLabel(ev)
                      // 已被用户追认：明确标注，避免误以为仍然被拒
                      if (ev.reconsidered) tagText = '已追认 · ' + tagText
                      tagCls = 'ag-tag-err'
                      glyphCls = 'ag-row-glyph-err'
                      glyph = React.createElement('span', null, '✕')
                    }
                  } else {
                    tagText = '自动放行 · ' + (VERDICT_LABELS[ev.verdict] || ev.verdict || 'auto')
                    tagCls = 'ag-tag' + (VERDICT_NEUTRAL.has(ev.verdict) ? ' ag-tag-neutral' : '')
                  }
                  return React.createElement('div', { className: 'ag-row' + (isRejectEvent(ev) && !ev.reconsidered ? ' ag-row-pending' : ''), key: ev.id },
                    React.createElement('div', { className: 'ag-row-rail' },
                      React.createElement('span', { className: glyphCls }, glyph),
                      React.createElement('span', { className: 'ag-row-line' }),
                    ),
                    React.createElement('div', { className: 'ag-row-body' },
                      React.createElement('div', { className: 'ag-row-top' },
                        React.createElement('span', { className: 'ag-row-tool' }, ev.tool || 'tool'),
                        React.createElement('span', { className: tagCls }, tagText),
                        React.createElement('span', { className: 'ag-time' }, fmtTime(ev.ts)),
                      ),
                      React.createElement('div', { className: 'ag-row-reason' }, ev.justification || ev.reason || '(无说明)'),
                      files.length > 0
                        ? React.createElement('div', { className: 'ag-row-files' },
                            files.map(function (f, i) {
                              // 该事件存在快照 → 文件可点击查看改动对比
                              const chipProps = { key: i, className: 'ag-file-chip' }
                              if (hasSnap(f)) {
                                chipProps.className += ' ag-file-chip-snap'
                                chipProps.title = '查看该文件改动对比'
                                chipProps.role = 'button'
                                chipProps.onClick = function () { setDiffOpen({ eventId: ev.id, path: f }) }
                              }
                              // 只显示文件名本身（去重后同一文件只有一个 chip）
                              const fname = String(f).split('/').pop()
                              return React.createElement('span', chipProps, fname)
                            }),
                          )
                        : null,
                      // 追认入口：仅判定层静默拒绝、且非硬风险类别（与 host 端围栏一致）
                      canReconsider
                        ? React.createElement('div', { className: 'ag-row-actions' },
                            React.createElement('button', {
                              type: 'button',
                              className: 'ag-set-btn ag-set-btn-primary',
                              disabled: busyId !== null,
                              title: '追认这次拒绝：写入自动放行规则，并让 AI 重试该操作',
                              onClick: function () { doReconsider(ev) },
                            }, busyId === ev.id ? '处理中…' : '重新审批通过'),
                            React.createElement('span', { className: 'ag-set-item-meta' }, '追认后同类操作将自动放行'),
                          )
                        : null,
                    ),
                  )
                }).filter(Boolean),
              ),
        diffOpen
          ? React.createElement(DiffPanel, {
              sessionId: sessionId,
              eventId: diffOpen.eventId,
              path: diffOpen.path,
              onClose: function () { setDiffOpen(null) },
            })
          : null,
      )
    }

    // ================= 设置页：自动审批规则管理（settings.section） =================
    const RULE_SOURCE_TAGS = {
      default: React.createElement('span', { className: 'ag-set-tag ag-set-tag-blue' }, '预置'),
      learned: React.createElement('span', { className: 'ag-set-tag ag-set-tag-green' }, '学习沉淀'),
      user: React.createElement('span', { className: 'ag-set-tag ag-set-tag-gray' }, '用户'),
    }
    function ruleSource(rule) {
      const d = String(rule && rule.description || '')
      if (d.indexOf('自动沉淀') === 0 || d.indexOf('人工确认后') >= 0 || d.indexOf('flash 同类') >= 0) return 'learned'
      if (d === '用户自定义') return 'user'
      return 'default'
    }

    function RulesSettings(props) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [feedback, setFeedback] = React.useState(null)
      const [newKeyword, setNewKeyword] = React.useState('')
      const [newRule, setNewRule] = React.useState({ tool: '', mode: '', category: '', contains: '' })
      const [threshold, setThreshold] = React.useState('3')
      const [timeoutMs, setTimeoutMs] = React.useState('20000')

      const load = function () {
        fetch('/api/auto-approve/rules', { headers: { 'cache-control': 'no-cache' } })
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data && data.config) {
              setSnapshot(data)
              setThreshold(String(data.config.riskyThreshold))
              setTimeoutMs(String(data.config.judgeTimeoutMs))
              setError(null)
            } else {
              setError('加载规则失败：' + JSON.stringify(data).slice(0, 200))
            }
          })
          .catch(function (e) { setError('加载规则失败：' + String((e && e.message) || e)) })
      }
      React.useEffect(function () { load() }, [])

      const showFeedback = function (msg, ok) {
        setFeedback({ msg: String(msg), ok: ok !== false })
        setTimeout(function () { setFeedback(null) }, 4000)
      }

      const api = function (body) {
        setBusy(true)
        return fetch('/api/auto-approve/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) { load(); showFeedback('已生效（热更新，无需重启）'); return res }
          showFeedback((res && res.error) || '操作失败', false)
          return res
        }).catch(function (e) {
          showFeedback('请求失败：' + String((e && e.message) || e), false)
        }).finally(function () { setBusy(false) })
      }

      const setupNow = function () {
        setBusy(true)
        fetch('/api/auto-approve/setup', { method: 'POST' })
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (res && res.ok) {
              if (res.status === 'already') showFeedback('权限预设已配置，无需操作')
              else showFeedback('已写入 cordis.patch.yml，请重启 dsh web 生效（status=' + res.status + '）')
            } else {
              showFeedback((res && res.error) || '初始化失败', false)
            }
            load()
          })
          .catch(function (e) { showFeedback('初始化请求失败：' + String((e && e.message) || e), false) })
          .finally(function () { setBusy(false) })
      }

      if (!snapshot) {
        return React.createElement('div', { className: 'ag-set' },
          React.createElement('div', { className: error ? 'ag-set-err' : 'ag-set-ok' }, error || '加载中…'))
      }

      const cfg = snapshot.config
      const setup = snapshot.setup || { configured: false }
      const predefined = snapshot.predefined || {}
      const preDeny = new Set(predefined.denyKeywords || [])
      const preAllow = (predefined.allowRules || []).map(function (r) { return JSON.stringify(r) })
      const preHard = new Set(predefined.hardCategories || [])
      const learnStats = snapshot.learning && snapshot.learning.stats ? snapshot.learning.stats : {}
      const learnHistory = snapshot.learning && snapshot.learning.history ? snapshot.learning.history : {}
      const statKeys = Object.keys(learnStats)
      const histKeys = Object.keys(learnHistory)

      return React.createElement('div', { className: 'ag-set' },
        React.createElement('h3', { className: 'ag-set-title' }, '自动审批'),
        React.createElement('p', { className: 'ag-set-intro' },
          '管理自动审批的放行与阻塞规则：查看当前判定管道、黑/白名单与学习进度，可自行添加规则（如把 edit 加入白名单后自动放行）或终止错误的学习。修改即时生效（热更新）。'),

        // ---- 初始化卡片 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' }, '初始化权限预设'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '安装后需在 profile 的 cordis.patch.yml 添加 auto-approve 权限预设（预设表在配置构造时冻结，无法自动扩展）。' +
              (setup.configured ? '当前已配置 ✓' : '当前未检测到，可一键写入。'))),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('button', {
              type: 'button',
              className: 'ag-set-btn' + (setup.configured ? '' : ' ag-set-btn-primary'),
              disabled: busy,
              onClick: setupNow,
            }, setup.configured ? '重新检查' : '一键配置权限预设'),
            !setup.configured ? React.createElement('span', { className: 'ag-set-note' }, '写入后需重启 dsh web 生效') : null,
          ),
        ),

        // ---- 管道总览 ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' }, '当前判定管道'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '每次沙箱越界按下述链路判定，下面的配置卡片按管道顺序排列：')),
          React.createElement('div', { className: 'ag-set-grid' },
            (cfg.hardCategories || []).map(function (c) {
              const isPre = preHard.has(c)
              return React.createElement('span', { className: 'ag-set-hc', key: c },
                c + (isPre ? '' : ' · 自定义'))
            })),
        ),

        // ---- 黑名单（denyKeywords） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' },
              React.createElement('span', { className: 'ag-set-stage' }, '① DENY 层'),
              '黑名单 · 不可逆危险词'),
            React.createElement('p', { className: 'ag-set-card-sub' }, '管道第一步：命中即转人工（fail-safe，最高优先）。可添加自定义危险词；删除预置词有风险，请谨慎。')),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('input', {
              className: 'ag-set-input', value: newKeyword, placeholder: '输入危险词，如 sudo rm',
              onChange: function (e) { setNewKeyword(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && newKeyword.trim()) { api({ op: 'add', kind: 'denyKeywords', value: newKeyword.trim() }); setNewKeyword('') } },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy || !newKeyword.trim(),
              onClick: function () { api({ op: 'add', kind: 'denyKeywords', value: newKeyword.trim() }); setNewKeyword('') },
            }, '添加'),
          ),
          (cfg.denyKeywords || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无黑名单词')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.denyKeywords.map(function (kw) {
                  return React.createElement('div', { className: 'ag-set-item', key: kw },
                    React.createElement('span', { className: 'ag-set-item-label' }, kw),
                    preDeny.has(kw)
                      ? React.createElement('span', { className: 'ag-set-item-meta' }, '预置')
                      : null,
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '删除', 'aria-label': '删除 ' + kw,
                      onClick: function () {
                        if (preDeny.has(kw) && !window.confirm('删除预置危险词「' + kw + '」会降低安全性，确定？')) return
                        api({ op: 'remove', kind: 'denyKeywords', value: kw })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 白名单（allowRules） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' },
              React.createElement('span', { className: 'ag-set-stage' }, '② 白名单层'),
              '白名单 · 自动放行规则'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '管道第二步：命中规则直接自动放行（不过 Flash）。示例：tool=edit + mode=danger-full-access → 所有工作区外 edit 自动放行。')),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('input', { className: 'ag-set-input', style: { width: 110 }, placeholder: 'tool', value: newRule.tool, onChange: function (e) { setNewRule(Object.assign({}, newRule, { tool: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 150 }, placeholder: 'mode（可选）', value: newRule.mode, onChange: function (e) { setNewRule(Object.assign({}, newRule, { mode: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 110 }, placeholder: 'category（可选）', value: newRule.category, onChange: function (e) { setNewRule(Object.assign({}, newRule, { category: e.target.value })) } }),
            React.createElement('input', { className: 'ag-set-input', style: { width: 130 }, placeholder: 'contains（可选）', value: newRule.contains, onChange: function (e) { setNewRule(Object.assign({}, newRule, { contains: e.target.value })) } }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn ag-set-btn-primary', disabled: busy || !(newRule.tool || newRule.mode || newRule.category || newRule.contains),
              onClick: function () {
                api({ op: 'add', kind: 'allowRules', value: newRule })
                setNewRule({ tool: '', mode: '', category: '', contains: '' })
              },
            }, '添加'),
          ),
          (cfg.allowRules || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无白名单规则')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.allowRules.map(function (rule, idx) {
                  const parts = []
                  if (rule.tool) parts.push('tool=' + rule.tool)
                  if (rule.mode) parts.push('mode=' + rule.mode)
                  if (rule.category) parts.push('category=' + rule.category)
                  if (rule.contains) parts.push('contains=' + rule.contains)
                  const label = parts.join('  ') || '(任意)'
                  const src = ruleSource(rule)
                  const isPre = preAllow.indexOf(JSON.stringify({ mode: rule.mode, description: rule.description })) >= 0 || (rule.mode === 'workspace-write' && !rule.tool && !rule.category && !rule.contains)
                  return React.createElement('div', { className: 'ag-set-item', key: idx },
                    React.createElement('span', { className: 'ag-set-item-label' }, label),
                    rule.description ? React.createElement('span', { className: 'ag-set-item-meta' }, rule.description) : null,
                    RULE_SOURCE_TAGS[src] || RULE_SOURCE_TAGS.default,
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '删除', 'aria-label': '删除规则',
                      onClick: function () {
                        api({ op: 'remove', kind: 'allowRules', value: { tool: rule.tool, mode: rule.mode, category: rule.category, contains: rule.contains } })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 永久人工（denyRules） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' },
              React.createElement('span', { className: 'ag-set-stage' }, '③ denyRules 层'),
              '永久人工 · 拒绝升级规则'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '管道第三步：neutral 操作被你拒绝后自动升级到这里，命中直接转人工（永不自动放行）。硬风险类别（删除/凭据/远程/系统/批量）本身永久人工，不在此记录。可手动移除。')),
          (cfg.denyRules || []).length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '无升级规则（硬风险类别本就永久人工，不在此记录）')
            : React.createElement('div', { className: 'ag-set-list' },
                cfg.denyRules.map(function (rule, idx) {
                  const parts = []
                  if (rule.tool) parts.push('tool=' + rule.tool)
                  if (rule.mode) parts.push('mode=' + rule.mode)
                  if (rule.category) parts.push('category=' + rule.category)
                  if (rule.contains) parts.push('contains=' + rule.contains)
                  return React.createElement('div', { className: 'ag-set-item', key: idx },
                    React.createElement('span', { className: 'ag-set-item-label' }, parts.join('  ') || '(任意)'),
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-item-del', title: '移除', 'aria-label': '移除规则',
                      onClick: function () {
                        api({ op: 'remove', kind: 'denyRules', value: { tool: rule.tool, mode: rule.mode, category: rule.category, contains: rule.contains } })
                      },
                    }, '✕'),
                  )
                }),
              ),
        ),

        // ---- 学习状态（⑤ 学习沉淀） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' },
              React.createElement('span', { className: 'ag-set-stage' }, '⑤ 学习沉淀'),
              '正在学习'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '中立操作人工确认制：同一「工具|模式|类别」每确认一次计数 +1，确认满 ' + cfg.riskyThreshold + ' 次后，第 ' + (cfg.riskyThreshold + 1) + ' 次起自动放行并沉淀规则。若学习有误可终止（删除计数与样本）。')),
          statKeys.length === 0
            ? React.createElement('div', { className: 'ag-set-empty' }, '暂无正在学习的内容')
            : React.createElement('div', { className: 'ag-set-learn' },
                statKeys.map(function (k) {
                  const samples = (learnHistory[k] || []).map(function (s) { return (s && (s.fp || s.ctx)) || '' }).join(' / ').slice(0, 160)
                  return React.createElement('div', { className: 'ag-set-learn-item', key: k },
                    React.createElement('div', { className: 'ag-set-learn-info' },
                      React.createElement('span', { className: 'ag-set-learn-key' }, k),
                      React.createElement('span', { className: 'ag-set-learn-sub' },
                        '已确认 ' + learnStats[k] + '/' + cfg.riskyThreshold + (samples ? ' · ' + samples : '')),
                    ),
                    React.createElement('button', {
                      type: 'button', className: 'ag-set-learn-stop', title: '终止学习（删除计数与样本）',
                      onClick: function () {
                        if (!window.confirm('终止「' + k + '」的学习？将删除其确认计数与样本。')) return
                        api({ op: 'remove', kind: 'learning', value: k })
                      },
                    }, '终止'),
                  )
                }),
              ),
        ),

        // ---- 阈值 / 超时（④ Flash 判定参数） ----
        React.createElement('div', { className: 'ag-set-card' },
          React.createElement('div', { className: 'ag-set-card-head' },
            React.createElement('div', { className: 'ag-set-card-title' },
              React.createElement('span', { className: 'ag-set-stage' }, '④ Flash 判定'),
              '阈值与超时'),
            React.createElement('p', { className: 'ag-set-card-sub' },
              '管道第四步：确认阈值 N（学习满 N 次后第 N+1 次自动放行）与 Flash 判断超时（超时自动重试 1 次，仍失败转人工）。')),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('span', { className: 'ag-set-item-meta' }, '确认阈值 N：'),
            React.createElement('input', {
              className: 'ag-set-input ag-set-input-num', type: 'number', min: 1, value: threshold,
              onChange: function (e) { setThreshold(e.target.value) },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy,
              onClick: function () { api({ op: 'set', kind: 'riskyThreshold', value: Number(threshold) }) },
            }, '保存'),
            React.createElement('span', { className: 'ag-set-item-meta' }, '满 ' + Number(threshold) + ' 次后第 ' + (Number(threshold) + 1) + ' 次起自动'),
          ),
          React.createElement('div', { className: 'ag-set-row' },
            React.createElement('span', { className: 'ag-set-item-meta' }, 'Flash 判断超时(ms)：'),
            React.createElement('input', {
              className: 'ag-set-input ag-set-input-num', type: 'number', min: 1000, value: timeoutMs,
              onChange: function (e) { setTimeoutMs(e.target.value) },
            }),
            React.createElement('button', {
              type: 'button', className: 'ag-set-btn', disabled: busy,
              onClick: function () { api({ op: 'set', kind: 'judgeTimeoutMs', value: Number(timeoutMs) }) },
            }, '保存'),
          ),
        ),

        // ---- 反馈 ----
        feedback
          ? React.createElement('div', { className: feedback.ok ? 'ag-set-ok' : 'ag-set-err' }, feedback.msg)
          : null,
      )
    }

    const plugin = {
      inject: ['timer'],
      async apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'dsh-approval-gate')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch (e) {
          console.error('[dsh-approval-gate] 注入样式失败：' + String((e && e.message) || e))
        }
        ctx.effect(() => {
          return () => {
            if (styleEl && styleEl.parentNode) {
              try { styleEl.parentNode.removeChild(styleEl) } catch (e) {}
            }
          }
        })

        // ✅ 自动放行提示条：输入框上方独立行（order=30，排在 todo/goal/queue 之下，天然不重叠）
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'dsh-approval-gate.notice', order: 30, label: '自动放行提示' },
            function (props) { return React.createElement(NoticeStrip, { slotsProps: props }) },
          )
        })

        // 审批历史视图：conversation.view（order=20，位于轨迹 order=10 右侧）
        slots.inject('conversation.view', function () {
          return slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-approval-gate.history',
              order: 20,
              label: '审批',
              inject: (sessionId) => ({ sessionId }),
            },
            function (props) { return React.createElement(HistoryView, { slotsProps: props }) },
          )
        })

        // 设置页：自动审批规则管理（settings.section）
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'dsh-approval-gate.settings', order: 60, label: '自动审批' },
            function (props) { return React.createElement(RulesSettings, { slotsProps: props }) },
          )
        })
      },
    }

    exports.default = plugin
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
