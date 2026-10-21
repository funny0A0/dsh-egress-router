// Settings tab UI. Loaded by the DSH client module loader inside the web GUI.
//
// 0.8.0: probe the loader instead of assuming it. When a host renames or replaces
// __ModuleLoader__, the old first line threw, the module never registered, and the settings
// page simply had no tab — with nothing anywhere saying why.
var __loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : null
if (!__loader || typeof __loader.load !== 'function') {
  if (typeof console !== 'undefined' && console.error) {
    console.error('[egress-router] this host does not expose window.__ModuleLoader__.load; the settings tab cannot register')
  }
} else
__loader.load({
  id: 'dsh-egress-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var BASE = '/plugins/egress-router'
    var REQUEST_TIMEOUT_MS = 90000

    // 0.8.0: one refresh at a time, newest wins. Concurrent refreshes used to race, so a slow
    // response could overwrite a newer one and make an applied route look unapplied again.
    var refreshSeq = 0
    var refreshController = null
    var refreshTimer = null

    // Two locales, chosen once from the browser. Everything user-facing goes through
    // t(); no string is assembled inline so a new locale is one object away.
    var ZH = {
      tab: '出口路由',
      title: '出口路由（Egress Router）',
      subtitle: '给单个目标开一个本机端口，请求经它转发；没开端口的目标继续直连。',
      scan: '扫描',
      rollbackLast: '回滚上次改动',
      portCheck: '端口检查',
      loading: '正在加载…',
      unavailable: '接口不可用：',
      profileMissing: '没找到 profile 的 cordis.patch.yml（插件以为 profile 在 {dir}）。扫描结果会是空的，请把这一段发给维护者。',
      scanning: '扫描中…',
      scanDone: '扫描完成：{n} 项',
      scanFailed: '扫描失败：',
      checking: '检查 {name} …',
      check: '检查',
      checkResult: '{name}：直连 {direct}{proxy} → {verdict}',
      failed: '失败',
      ok: '成功',
      checkFailed: '检查失败：',
      portRequired: '请先填端口（建议 8791 起）',
      findPort: '找端口',
      proxyLabel: '代理',
      proxyDirect: '直连',
      botApply: '用这个代理',
      botSummary: '补丁 {patch} · 当前 {proxy}',
      botApplied: '{name} 已设为经 {proxy} 出网（本会话生效）',
    botLaunchHint: '要在启动前就生效，请设为操作系统环境变量；不要写进 .env，启动器会拒绝并停止启动',
      botHint: '机器人把 vendor 地址写死在代码里，所以用「补丁 + 环境变量」接管：{env}（只注入本进程，不写 .env）',
      portSuggested: '已找到空闲端口 {port}，点「应用」使用',
      portSuggestedAuto: '已自动填入空闲端口 {port}',
      noFreePort: '8791–8888 之间没有可用端口，请手动指定',
      portInUseAuto: '端口 {port} 被占用，已自动换成 {next}，请再点一次「应用」',
      plan: '预检',
      planning: '预检中…',
      planReady: '预检完成：写入前请确认改动',
      planFailed: '预检失败：',
      planPortBusy: '端口 {port} 已被占用',
      planPortFree: '端口 {port} 空闲',
      emptyResponse: '插件接口返回了空响应（HTTP {status}）：宿主可能还没加载本插件，或设置页刚刷新。',
      originPlaceholder: '原始地址 https://…',
      pausedHint: '{provider}：外部在反复改写这个值，自动修复已暂停至 {until}',
      portsSummary: '端口检查：{free} 个空闲，{taken} 个被占用',
      apply: '应用',
      applying: '应用中…',
      applied: '已应用：{id} → 127.0.0.1:{port}{tail}',
      restartTail: '（重启 DSH 后生效）',
      applyFailed: '应用失败：',
      applyUnverified: '目标连不上，已自动回滚：',
      test: '测试',
      testing: '测试中…',
      testReached: '真实请求：HTTP {status} · {ms}ms',
      testNoStatus: '真实请求：已连上但没收到 HTTP 响应（{ms}ms）',
      testFailed: '真实请求失败：',
      undo: '撤销',
      rollingBack: '回滚中…',
      rolledBack: '已回滚 → {what}{tail}',
      rollbackFailed: '回滚失败：',
      confirmOverwrite: 'cordis.patch.yml 在应用之后被修改过。仍然用备份覆盖这些改动吗？',
      cancelled: '已取消回滚：文件在应用后被修改过，未覆盖',
      needsManual: '需手动处理（无可改写的 baseURL）',
      found: '发现到的外连目标（{n}）',
      noTargets: '还没有扫描到目标，点「扫描」试试。',
      guardedNote: '受保护域名 {n} 个，不提供改写：',
      recent: '最近操作',
      opStart: '启动',
      opApply: '应用',
      opRollback: '回滚',
      opPatchVerify: '补丁检查',
      opPatchRepair: '补丁自修复',
      opDuplicate: '重复实例已忽略',
      opDiscover: '扫描',
      kindLlm: '模型',
      kindIm: '消息',
      kindGuarded: '受保护',
      kindOther: '外连',
      lowConfidence: '待确认',
      routed: '已路由',
    staleRoute: '中转已撤销',
    staleHint: '配置仍指向已撤销的中转；点「应用」会按记录的原始地址重新建立。',
      guardedTag: '不建议改',
      running: '运行中 :{port}',
      down: '失败 :{port}',
      noTraffic: '暂无流量',
      traffic: '{n} 次 · ↑{in} ↓{out} · p50 {p50}ms · 5xx {err}',
      noProxy: '直连',
      viaProxy: '经 {proxy}',
      timeout: '请求超时（{s} 秒），请刷新后查看结果',
      unauthorized: '未授权：请从 DSH 设置页操作（{msg}）',
      httpError: 'HTTP {status}',
      diffBefore: '改前',
      diffAfter: '改后',
      closePreview: '收起',
      advanced: '连接参数',
      maxSockets: '并发',
      timeoutMs: '超时(ms)',
      driftWarning: '配置文件与运行中的监听不一致：{detail}',
      contractDegraded: '当前宿主没有接受任何已知的接口注册形状：设置页暂时读不到后端，但路由与中转仍在运行。',
      repairConfig: '修复配置',
      repairDone: '已修复 {n} 项：{detail}',
      repairNone: '配置与监听一致，无需修复',
      patchesTitle: '兼容补丁',
      patchesHint: '有些插件把地址写死在代码里，只能改安装文件。这里声明的补丁会在重装/升级后自动修复。',
      patchApply: '应用补丁',
      patchRevert: '复原',
      patchVerify: '重新检查',
      patchApplied: '已应用补丁：{id}{tail}',
      patchReverted: '已复原：{id}{tail}',
      patchFailed: '补丁操作失败：',
      patchExternal: '由其它方式（如 pnpm patch）提供，此处只读',
      stApplied: '已生效',
      stPending: '未应用',
      stMissingPackage: '未安装',
      stUnsupported: '版本不支持',
      stAnchorMissing: '锚点缺失',
      stAnchorAmbiguous: '锚点不唯一',
      stError: '错误',
    }
    var EN = {
      tab: 'Egress Router',
      title: 'Egress Router',
      subtitle: 'Give one target its own loopback port and forward through it; targets without a port keep connecting directly.',
      scan: 'Scan',
      rollbackLast: 'Revert last change',
      portCheck: 'Check ports',
      loading: 'Loading…',
      unavailable: 'API unavailable: ',
      profileMissing: 'This plugin could not find the profile cordis.patch.yml (it looked in {dir}). Scans will come back empty — please report this output.',
      scanning: 'Scanning…',
      scanDone: 'Scan finished: {n} targets',
      scanFailed: 'Scan failed: ',
      checking: 'Checking {name} …',
      check: 'Check',
      checkResult: '{name}: direct {direct}{proxy} → {verdict}',
      failed: 'failed',
      ok: 'ok',
      checkFailed: 'Check failed: ',
      portRequired: 'Enter a port first (8791 and up)',
      findPort: 'Find port',
      proxyLabel: 'Proxy',
      proxyDirect: 'Direct',
      botApply: 'Use this proxy',
      botSummary: 'patch {patch} · now {proxy}',
      botApplied: '{name} now egresses through {proxy} (this session)',
    botLaunchHint: 'To have it before start-up, set it in the OS environment; never in .env — the launcher refuses to boot',
      botHint: 'The bot hardcodes its vendor host, so this row owns a patch plus an env var: {env}',
      portSuggested: 'Free port {port} found; press Apply to use it',
      portSuggestedAuto: 'Filled in free port {port}',
      noFreePort: 'No free port between 8791 and 8888; set one manually',
      portInUseAuto: 'Port {port} is taken; switched to {next}; press Apply again',
      plan: 'Preview',
      planning: 'Previewing…',
      planReady: 'Preview ready — review the change before writing',
      planFailed: 'Preview failed: ',
      planPortBusy: 'Port {port} is already in use',
      planPortFree: 'Port {port} is free',
      emptyResponse: 'The plugin endpoint returned an empty response (HTTP {status}); the host may not have loaded this plugin yet, or the page was just refreshed.',
      originPlaceholder: 'Original endpoint https://…',
      pausedHint: '{provider}: something else keeps rewriting this value; auto-repair paused until {until}',
      portsSummary: 'Ports: {free} free, {taken} in use',
      apply: 'Apply',
      applying: 'Applying…',
      applied: 'Applied: {id} → 127.0.0.1:{port}{tail}',
      restartTail: ' (takes effect after a DSH restart)',
      applyFailed: 'Apply failed: ',
      applyUnverified: 'Target unreachable, rolled back: ',
      test: 'Test',
      testing: 'Testing…',
      testReached: 'Live request: HTTP {status} · {ms}ms',
      testNoStatus: 'Live request: connected, but no HTTP response ({ms}ms)',
      testFailed: 'Live request failed: ',
      undo: 'Remove',
      rollingBack: 'Reverting…',
      rolledBack: 'Reverted → {what}{tail}',
      rollbackFailed: 'Revert failed: ',
      confirmOverwrite: 'cordis.patch.yml changed after the last apply. Overwrite those edits with the backup?',
      cancelled: 'Revert cancelled: the file changed after apply',
      needsManual: 'Handle manually (no baseURL to rewrite)',
      found: 'Discovered targets ({n})',
      noTargets: 'Nothing discovered yet — press Scan.',
      guardedNote: '{n} guarded hosts are never rewritten: ',
      recent: 'Recent operations',
      opStart: 'startup',
      opApply: 'apply',
      opRollback: 'rollback',
      opPatchVerify: 'patch check',
      opPatchRepair: 'patch repair',
      opDuplicate: 'duplicate ignored',
      opDiscover: 'scan',
      kindLlm: 'model',
      kindIm: 'messaging',
      kindGuarded: 'guarded',
      kindOther: 'outbound',
      lowConfidence: 'unconfirmed',
      routed: 'routed',
    staleRoute: 'relay removed',
    staleHint: 'This provider still points at a relay you removed; Apply rebuilds it from the recorded endpoint.',
      guardedTag: 'do not rewrite',
      running: 'running :{port}',
      down: 'down :{port}',
      noTraffic: 'no traffic yet',
      traffic: '{n} req · ↑{in} ↓{out} · p50 {p50}ms · 5xx {err}',
      noProxy: 'direct',
      viaProxy: 'via {proxy}',
      timeout: 'Request timed out after {s}s — refresh to see the outcome',
      unauthorized: 'Not authorized: open this from the DSH settings page ({msg})',
      httpError: 'HTTP {status}',
      diffBefore: 'before',
      diffAfter: 'after',
      closePreview: 'Close',
      advanced: 'Connection',
      maxSockets: 'sockets',
      timeoutMs: 'timeout(ms)',
      driftWarning: 'The config file disagrees with the running listeners: {detail}',
      contractDegraded: 'This host accepted none of the known API registration shapes: the page cannot reach the backend, but routing and relays keep running.',
      repairConfig: 'Repair config',
      repairDone: 'Repaired {n} provider(s): {detail}',
      repairNone: 'Config and listeners already agree',
      patchesTitle: 'Compatibility patches',
      patchesHint: 'Some plugins hardcode their endpoint. These declared patches edit the installed file and are repaired automatically after a reinstall or upgrade.',
      patchApply: 'Apply patch',
      patchRevert: 'Restore',
      patchVerify: 'Re-check',
      patchApplied: 'Patch applied: {id}{tail}',
      patchReverted: 'Restored: {id}{tail}',
      patchFailed: 'Patch failed: ',
      patchExternal: 'provided elsewhere (e.g. pnpm patch); read-only here',
      stApplied: 'applied',
      stPending: 'not applied',
      stMissingPackage: 'not installed',
      stUnsupported: 'unsupported version',
      stAnchorMissing: 'anchor missing',
      stAnchorAmbiguous: 'anchor not unique',
      stError: 'error',
    }
    var locale = (typeof navigator !== 'undefined' && navigator && navigator.language) || 'zh'
    var DICT = /^zh/i.test(String(locale)) ? ZH : EN

    function t(key, vars) {
      var text = DICT[key] || ZH[key] || key
      if (!vars) return text
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return vars[name] === undefined || vars[name] === null ? match : String(vars[name])
      })
    }

    function fmtBytes(value) {
      var n = Number(value) || 0
      if (n < 1024) return n + 'B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB'
      return (n / 1024 / 1024).toFixed(1) + 'MB'
    }

    function call(op, body, params, signal) {
      var query = '?op=' + encodeURIComponent(op)
      if (params) {
        Object.keys(params).forEach(function (key) {
          var value = params[key]
          if (value === undefined || value === null || value === '') return
          query += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(String(value))
        })
      }
      var options = {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }
      // Never leave a button stuck on "applying…" when the host is busy (R11). A caller that
      // needs to cancel (the refresh path) supplies its own signal and owns the clock.
      if (signal) options.signal = signal
      else if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      return fetch(BASE + query, options).catch(function (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new Error(t('timeout', { s: Math.round(REQUEST_TIMEOUT_MS / 1000) }))
        }
        throw err
      }).then(function (res) {
        // Read the body as text first: a 404 from the host shell (or an intermediary's
        // splash page) carries an empty or non-JSON body, and res.json() used to surface
        // "Unexpected end of JSON input" to the user instead of a usable explanation.
        return res.text().then(function (text) {
          var data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch {
            data = null
          }
          if (!res.ok) {
            var reason = data && (data.message || data.error)
            var fallback = data ? t('httpError', { status: res.status }) : t('emptyResponse', { status: res.status })
            var message = reason ? String(reason) : fallback
            if (res.status === 403 || res.status === 401) message = t('unauthorized', { msg: message })
            var error = new Error(message)
            error.status = res.status
            if (data && data.error) error.code = data.error
            throw error
          }
          if (!data) throw new Error(t('emptyResponse', { status: res.status }))
          return data
        })
      })
    }

    // Style: the host's own design tokens (--dsw-alias-*, --dsw-radius-*,
    // --dsw-font-*) so the tab follows DSH's light/dark theme instead of hardcoding
    // colours. Fallbacks are neutral, so a token rename degrades instead of breaking.
    // Token names below are verified against DSH's own theme bundle (the alias blocks in
    // app.asar). There is no bare --dsw-alias-label and no --dsw-alias-hairline: referencing
    // them fell through to a fixed hex colour, which is what made button text unreadable in
    // one of the two themes. Everything here resolves through real tokens with inherit-based
    // fallbacks, so the panel follows whatever theme the host is in.
    var monoFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    var labelPrimary = 'var(--dsw-alias-label-primary, inherit)'
    var labelSecondary = 'var(--dsw-alias-label-secondary, inherit)'
    var labelTertiary = 'var(--dsw-alias-label-tertiary, inherit)'
    var borderL1 = '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14))'
    var borderL2 = '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))'
    var borderL3 = '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.26))'
    var borderL4 = '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.34))'
    var box = {
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: borderL3,
      borderRadius: 'var(--dsw-radius-md, 12px)',
      padding: 14,
      marginBottom: 12,
      boxSizing: 'border-box',
      maxWidth: '100%',
      minWidth: 0,
    }
    var sectionTitle = { fontWeight: 600, fontSize: 13, lineHeight: '18px', color: labelPrimary, marginBottom: 8 }
    var hint = {
      fontSize: 12,
      lineHeight: 1.55,
      color: labelTertiary,
      overflowWrap: 'anywhere',
    }
    var row = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '10px 0',
      borderTop: borderL2,
      minWidth: 0,
      maxWidth: '100%',
    }
    var rowHead = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }
    var name = { fontWeight: 500, fontSize: 13, lineHeight: '18px', color: labelPrimary, minWidth: 0, overflowWrap: 'anywhere' }
    var mono = {
      fontFamily: monoFont,
      fontSize: 12,
      lineHeight: 1.5,
      color: labelTertiary,
      minWidth: 0,
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    }
    var actions = { display: 'flex', flexWrap: 'wrap', gap: 6, rowGap: 6, alignItems: 'center', minWidth: 0 }
    var headerBar = { display: 'flex', flexWrap: 'wrap', gap: 8, rowGap: 8, justifyContent: 'space-between', alignItems: 'center' }
    // Mirrors the .chip rule DSH uses for secondary buttons: 28px tall, .5px border-l4,
    // radius-sm, 13px label-primary text on a transparent fill.
    var btn = {
      height: 28,
      padding: '0 12px',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      border: borderL4,
      background: 'transparent',
      color: labelPrimary,
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: '18px',
      cursor: 'pointer',
      flex: '0 0 auto',
      whiteSpace: 'nowrap',
    }
    // Mirrors the active chip: primary fill with the inverted foreground token.
    var btnPrimary = Object.assign({}, btn, {
      background: 'var(--dsw-alias-button-primary-fill, #4176e6)',
      borderColor: 'transparent',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      fontWeight: 500,
    })
    var input = {
      height: 28,
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      border: borderL4,
      background: 'var(--dsw-alias-button-elevated-fill, transparent)',
      color: labelPrimary,
      fontFamily: 'inherit',
      fontSize: 13,
      boxSizing: 'border-box',
      outline: 'none',
    }
    var portInput = Object.assign({}, input, { width: 84, flex: '0 0 auto' })
    var proxySelect = Object.assign({}, input, { width: 96, flex: '0 0 auto', paddingLeft: 6 })
    var originInput = Object.assign({}, input, { width: 240, maxWidth: '100%', flex: '1 1 160px', minWidth: 0 })
    var numInput = Object.assign({}, input, { width: 92, flex: '0 0 auto' })
    var tagBase = {
      fontSize: 11,
      lineHeight: '18px',
      padding: '0 6px',
      borderRadius: 'var(--dsw-radius-xs, 4px)',
      border: '0.5px solid transparent',
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
    }
    var tag = Object.assign({}, tagBase, {
      background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))',
      color: labelSecondary,
    })
    // Tag text is mixed with the theme's primary label colour: a raw amber or green reads well
    // on black but fails contrast on white, and the host ships no success/error "label" tokens,
    // so mixing is what keeps a badge legible in both themes.
    function tonePair(token, fallback) {
      return [
        'color-mix(in srgb, var(' + token + ', ' + fallback + ') 16%, transparent)',
        'color-mix(in srgb, var(' + token + ', ' + fallback + ') 55%, var(--dsw-alias-label-primary, currentColor))',
      ]
    }
    var TONES = {
      ok: tonePair('--dsw-alias-state-success-primary', '#22c55e'),
      warn: tonePair('--dsw-alias-state-warn-primary', '#f59e0b'),
      bad: tonePair('--dsw-alias-state-error-primary', '#ec1313'),
      info: tonePair('--dsw-alias-link', '#4176e6'),
    }
    function tagTone(tone) {
      var pair = TONES[tone] || TONES.info
      return Object.assign({}, tagBase, { background: pair[0], color: pair[1] })
    }
    function patchTone(status) {
      if (status === 'applied') return 'ok'
      if (status === 'pending') return 'info'
      if (status === 'missing_package') return 'warn'
      return 'bad'
    }
    var diffBox = {
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      border: borderL3,
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      padding: 10,
      marginTop: 8,
      fontFamily: monoFont,
      fontSize: 11.5,
      color: labelSecondary,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      minWidth: 0,
    }
    function kindLabel(kind) {
      if (kind === 'llm') return t('kindLlm')
      if (kind === 'im') return t('kindIm')
      if (kind === 'guarded') return t('kindGuarded')
      return t('kindOther')
    }

    function isPatchable(item) {
      if (!item) return false
      if (item.patchable === false) return false
      if (item.patchable === true) return true
      return String(item.id || '').indexOf('llm:') === 0
    }

    function EgressPanel() {
      var state = React.useState({ loading: true })
      var data = state[0]
      var setData = state[1]
      var proxyState = React.useState({})
      var proxies = proxyState[0]
      var setProxies = proxyState[1]
      var portState = React.useState({})
      var ports = portState[0]
      var setPorts = portState[1]
      var advState = React.useState({})
      var advanced = advState[0]
      var setAdvanced = advState[1]
      var msgState = React.useState(null)
      var message = msgState[0]
      var setMessage = msgState[1]
      var previewState = React.useState(null)
      var preview = previewState[0]
      var setPreview = previewState[1]
      var busyState = React.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // Any write in flight disables every write button: a second click used to queue a
      // conflicting write and a duplicate history line (U1, 0.8.0).
      var anyBusy = busy !== null && busy !== undefined

      // `state` carries routes and listeners but not the row list — the table renders
      // `discovered`. Refreshing only `state` after a mutation left the row saying
      // "not routed" until the user pressed Scan again, and opening the page without
      // scanning showed an empty table, which read as "my configuration was lost" (0.5.3).
      function refreshAll(options) {
        var quiet = !!(options && options.quiet)
        var seq = (refreshSeq += 1)
        if (refreshController) { try { refreshController.abort() } catch (err) {} }
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        refreshController = controller
        var signal = controller ? controller.signal : undefined
        var timer = controller ? setTimeout(function () {
          try { controller.abort() } catch (err) {}
        }, REQUEST_TIMEOUT_MS) : null
        var settle = function () { if (timer) clearTimeout(timer) }
        if (!quiet) setMessage(t('loading'))
        return Promise.all([call('state', null, null, signal), call('discover', {}, null, signal)]).then(function (results) {
          settle()
          // A newer refresh already started: its answer is the one the page should show.
          if (seq !== refreshSeq) return null
          var next = Object.assign({}, results[0] || {})
          next.discovered = results[1]
          if (results[1] && results[1].warnings) next.warnings = results[1].warnings
          setData(next)
          if (!quiet) setMessage(null)
          return next
        }).catch(function (err) {
          settle()
          if (seq !== refreshSeq) return null
          if (!quiet) setMessage(null)
          if (quiet) setData(function (prev) { return Object.assign({}, prev, { error: err.message }) })
          else setData({ error: err.message })
        })
      }

      // Quiet refreshes arrive in bursts (apply, rollback, port check, patch action); collapse
      // a burst into one request instead of racing three of them.
      function refreshSoon() {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(function () {
          refreshTimer = null
          refreshSoon()
        }, 150)
      }

      React.useEffect(function () {
        refreshAll()
        return function () {
          if (refreshTimer) clearTimeout(refreshTimer)
          if (refreshController) { try { refreshController.abort() } catch (err) {} }
        }
      }, [])

      // The host can rewrite cordis.patch.yml behind our back; when that happens the
      // provider talks to a port nobody listens on. Surface it and offer a one-click fix.
      function driftItems() {
        var info = data && data.drift
        return info && info.drift ? info.drift : []
      }

      function contractNotice() {
        var contract = data && (data.contract || data.hostContract)
        if (!contract || contract.ok !== false) return null
        return h('div', {
          role: 'alert',
          style: Object.assign({}, box, hint, { padding: '8px 12px', borderColor: 'var(--dsw-alias-state-error-primary, #f85149)' }),
        }, '⛔ ' + t('contractDegraded') + (contract.detail ? ' — ' + contract.detail : ''))
      }

      function repairConfig() {
        setMessage(t('loading'))
        call('reconcile', {}).then(function (result) {
          var repaired = result.repaired || []
          setMessage(repaired.length
            ? t('repairDone', { n: repaired.length, detail: repaired.map(function (item) { return item.provider + ' -> :' + item.listenPort }).join(', ') })
            : t('repairNone'))
          refreshSoon()
        }).catch(function (err) { setMessage(t('patchFailed') + err.message) })
      }

      function scan() {
        setMessage(t('scanning'))
        call('discover', {}).then(function (result) {
          setData(function (prev) { return Object.assign({}, prev, { discovered: result, warnings: result.warnings }) })
          setMessage(t('scanDone', { n: result.items.length }))
        }).catch(function (err) { setMessage(t('scanFailed') + err.message) })
      }

      function check(item) {
        setMessage(t('checking', { name: item.target || item.name }))
        call('probe', { target: item.target, id: item.id, proxy: item.proxy || null }).then(function (result) {
          setMessage(t('checkResult', {
            name: item.name || item.id,
            direct: result.direct.ok ? result.direct.ms + 'ms' : t('failed'),
            proxy: result.proxy ? ' / ' + (result.proxy.ok ? result.proxy.ms + 'ms' : t('failed')) : '',
            verdict: result.verdict,
          }))
        }).catch(function (err) { setMessage(t('checkFailed') + err.message) })
      }

      function checkPorts() {
        var candidates = (data.discovered && data.discovered.items ? data.discovered.items : [])
          .filter(function (item) { return isPatchable(item) && item.target })
          .map(function (item) { return Number(ports[item.id] || item.listenPort || 0) })
          .filter(function (port) { return port > 0 })
        setMessage(t('portCheck') + '…')
        // The endpoint takes repeated `port` params; build them by hand.
        var query = candidates.map(function (port) { return '&port=' + encodeURIComponent(port) }).join('')
        setMessage(t('loading'))
        callRaw('GET', BASE + '?op=ports' + query, null).then(function (result) {
          var free = 0
          var taken = 0
          Object.keys(result.ports || {}).forEach(function (key) { (result.ports[key] ? free++ : taken++) })
          setMessage(t('portsSummary', { free: free, taken: taken }))
          refreshSoon()
        }).catch(function (err) { setMessage(t('checkFailed') + err.message) })
      }

      function callRaw(method, url, body) {
        var options = { method: method, headers: { 'content-type': 'application/json' } }
        if (body) options.body = JSON.stringify(body)
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        return fetch(url, options).then(function (res) {
          return res.json().then(function (json) {
            if (!res.ok) throw new Error((json && (json.message || json.error)) || t('httpError', { status: res.status }))
            return json
          })
        })
      }

      function suggestPort(item) {
        setBusy(item.id + ':port')
        return callRaw('GET', BASE + '?op=suggest&itemId=' + encodeURIComponent(item.id || ''), null)
          .then(function (result) {
            if (!result || !result.port) { setMessage(t('noFreePort')); return 0 }
            var next = Object.assign({}, ports)
            next[item.id] = String(result.port)
            setPorts(next)
            return Number(result.port)
          })
          .catch(function (err) { setMessage(t('applyFailed') + err.message); return 0 })
          .then(function (port) { setBusy(null); return port })
      }

      // A row without a port used to fall back to a constant and collide with the
      // route already listening there; ask the host for one that is really free.
      function ensurePort(item, announce) {
        var current = Number(ports[item.id] || item.listenPort || 0)
        if (current) return Promise.resolve(current)
        return suggestPort(item).then(function (port) {
          if (port && announce) setMessage(t('portSuggestedAuto', { port: port }))
          return port
        })
      }

      // Options come from config.proxies, so a proxy added to cordis.patch.yml shows up
      // here without a plugin release.
      function proxyOptions() {
        var table = (data && data.config && data.config.proxies) || {}
        return [h('option', { value: '' }, t('proxyDirect'))].concat(Object.keys(table).map(function (name) {
          return h('option', { value: name }, name)
        }))
      }

      // Chat bots expose no baseURL: their egress is a managed patch plus one
      // environment variable, so the row needs its own controls (0.5.0).
      function botInfo(item) {
        var list = (data && data.bots) || []
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === item.bot) return list[i]
        }
        return null
      }

      function botValue(item) {
        if (proxies[item.id] !== undefined) return proxies[item.id]
        var info = botInfo(item)
        return info && info.proxy ? info.proxy : ''
      }

      function applyBot(item, value) {
        setBusy(item.id + ':bot')
        callRaw('POST', BASE + '?op=bot', { id: item.bot, proxy: value })
          .then(function (result) {
            setData(function (prev) { return Object.assign({}, prev, { bots: result.bots }) })
            // The hint used to exist in both locales and never reach the page (U3).
            setMessage(t('botApplied', { name: item.name || item.id, proxy: value || t('proxyDirect') }) + ' — ' + t('botLaunchHint'))
            refreshSoon()
          })
          .catch(function (err) { setMessage(t('applyFailed') + err.message) })
          .then(function () { setBusy(null) })
      }

      // H11: an origin typed into a stale row rides along with the next preview/apply.
      var pendingOrigins = {}

      function itemBody(item, forcedPort) {
        var port = Number(forcedPort || ports[item.id] || item.listenPort || 0)
        if (!port) { setMessage(t('portRequired')); return null }
        var body = { itemId: item.id, target: item.target, listenPort: port }
        if (pendingOrigins[item.id]) body.origin = pendingOrigins[item.id]
        var chosen = proxies[item.id]
        if (chosen !== undefined) body.proxy = chosen
        else if (item.proxy) body.proxy = item.proxy
        var adv = advanced[item.id] || {}
        if (adv.maxSockets) body.maxSockets = Number(adv.maxSockets)
        if (adv.timeoutMs) body.timeoutMs = Number(adv.timeoutMs)
        return { body: body, port: port }
      }

      function planItem(item) {
        if (!isPatchable(item)) { setMessage(t('needsManual')); return }
        ensurePort(item, true).then(function (port) {
          if (!port) return
          var prepared = itemBody(item, port)
          if (!prepared) return
          setBusy(item.id + ':plan')
          setMessage(t('planning'))
          call('plan', prepared.body)
            .then(function (result) {
              setPreview({ id: item.id, diff: result.diff, portFree: result.portFree, port: prepared.port, warnings: result.warnings || [] })
              setMessage(result.portFree ? t('planReady') : t('planPortBusy', { port: prepared.port }))
            })
            .catch(function (err) { setMessage(t('planFailed') + err.message) })
            .then(function () { setBusy(null) })
        })
      }
      function applyItem(item) {
        if (!isPatchable(item)) { setMessage(t('needsManual')); return }
        ensurePort(item, true).then(function (port) {
          if (!port) return
          var prepared = itemBody(item, port)
          if (!prepared) return
          setBusy(item.id + ':apply')
          setMessage(t('applying'))
          // Never send proxy: null for a row that already has one — the server keeps the
          // existing proxy unless this body explicitly overrides it.
          call('apply', prepared.body)
            .then(function (result) {
              var tail = result.restartRequired ? t('restartTail') : ''
              setMessage(t('applied', { id: item.id, port: prepared.port, tail: tail }))
              setPreview(null)
              refreshSoon()
            })
            .catch(function (err) {
              if (err.code === 'apply_unverified') {
                setMessage(t('applyUnverified') + (err.message || ''))
                refreshSoon()
                return
              }
              if (err.code === 'port_in_use') {
                var taken = prepared.port
                suggestPort(item).then(function (next) {
                  setMessage(next ? t('portInUseAuto', { port: taken, next: next }) : t('noFreePort'))
                })
                return
              }
              setMessage(t('applyFailed') + err.message)
            })
            .then(function () { setBusy(null) })
        })
      }

      function testItem(item) {
        setBusy(item.id + ':test')
        setMessage(t('testing'))
        call('test', { id: item.id, path: '/' })
          .then(function (result) {
            var hasStatus = result.status !== null && result.status !== undefined
            setMessage(t(hasStatus ? 'testReached' : 'testNoStatus', { status: result.status, ms: result.ms }))
          })
          .catch(function (err) { setMessage(t('testFailed') + err.message) })
          .then(function () { setBusy(null) })
      }

      function rollback(itemId) {
        setMessage(t('rollingBack'))
        call('rollback', itemId ? { itemId: itemId } : {})
          .then(function (result) {
            var what = result.restored && result.restored.restored ? result.restored.restored : '-'
            setMessage(t('rolledBack', { what: what, tail: result.restartRequired ? t('restartTail') : '' }))
            refreshSoon()
          })
          .catch(function (err) {
            // 0.2.2: the file changed after apply. Ask before overwriting hand edits.
            if (err.code === 'file_changed_since_backup') {
              var ok = typeof window !== 'undefined' && window.confirm ? window.confirm(t('confirmOverwrite')) : false
              if (!ok) { setMessage(t('cancelled')); return }
              call('rollback', itemId ? { itemId: itemId, force: true } : { force: true })
                .then(function (result) {
                  var what = result.restored && result.restored.restored ? result.restored.restored : '-'
                  setMessage(t('rolledBack', { what: what, tail: result.restartRequired ? t('restartTail') : '' }))
                  refreshSoon()
                })
                .catch(function (second) { setMessage(t('rollbackFailed') + second.message) })
              return
            }
            setMessage(t('rollbackFailed') + err.message)
          })
      }

      function patchStatusLabel(status) {
        if (status === 'applied') return t('stApplied')
        if (status === 'pending') return t('stPending')
        if (status === 'missing_package') return t('stMissingPackage')
        if (status === 'unsupported') return t('stUnsupported')
        if (status === 'anchor_missing') return t('stAnchorMissing')
        if (status === 'anchor_ambiguous') return t('stAnchorAmbiguous')
        return t('stError')
      }

      function patchAction(item, action) {
        setBusy('patch:' + item.id + ':' + action)
        setMessage(t('loading'))
        call('patch', { id: item.id, action: action })
          .then(function (result) {
            var tail = result.restartRequired ? t('restartTail') : ''
            if (action === 'revert') setMessage(t('patchReverted', { id: item.id, tail: tail }))
            else if (action === 'apply') setMessage(t('patchApplied', { id: item.id, tail: tail }))
            else setMessage(t('patchesTitle') + ': ' + patchStatusLabel(result.patch && result.patch.status))
            refreshSoon()
          })
          .catch(function (err) { setMessage(t('patchFailed') + err.message) })
          .then(function () { setBusy(null) })
      }

      if (data.error) return h('div', { style: box }, t('unavailable') + data.error)
      if (data.loading) return h('div', { style: box }, t('loading'))

      // Silent-failure guard: a wrong profileDir makes every scan come back empty, which reads
      // as "there is nothing to configure" instead of "the plugin is looking in the wrong
      // place". Say it out loud (0.7.3).
      var profileWarning = data.profileOk === false
        ? h('div', { role: 'alert', style: box }, t('profileMissing', { dir: data.profileDir || '' }))
        : null

      var discovered = data.discovered || { items: [] }
      var listening = {}
      ;(data.status || []).forEach(function (item) { listening[item.id] = item })
      var metrics = data.metrics || {}
      var guarded = []
      var visible = []
      ;(discovered.items || []).forEach(function (item) { (item.guarded ? guarded : visible).push(item) })

      function metricsLine(item) {
        var live = metrics[item.id]
        var parts = []
        if (live && live.requests) {
          parts.push(t('traffic', {
            n: live.requests,
            in: fmtBytes(live.bytesIn),
            out: fmtBytes(live.bytesOut),
            p50: live.ttfbP50 === null ? '—' : live.ttfbP50,
            err: live.errors,
          }))
        } else if (item.routed) {
          parts.push(t('noTraffic'))
        }
        if (item.routed) parts.push(item.proxy ? t('viaProxy', { proxy: item.proxy }) : t('noProxy'))
        if (!parts.length) return null
        return h('div', { style: Object.assign({}, mono, { fontSize: 11 }) }, parts.join(' · '))
      }

      function previewBlock(item) {
        if (!preview || preview.id !== item.id) return null
        var rows = (preview.diff || []).map(function (entry, index) {
          return h('div', { key: 'd' + index },
            h('div', null, entry.path),
            h('div', null, t('diffBefore') + ': ' + formatValue(entry.before)),
            h('div', null, t('diffAfter') + ': ' + formatValue(entry.after)))
        })
        return h('div', { style: diffBox },
          rows,
          preview.port ? h('div', { style: Object.assign({}, hint, { marginTop: 6 }) },
            preview.portFree === false ? t('planPortBusy', { port: preview.port }) : t('planPortFree', { port: preview.port })) : null,
          h('div', { style: { marginTop: 6 } },
            h('button', { style: btn, disabled: anyBusy, onClick: function () { setPreview(null) } }, t('closePreview'))))
      }

      function formatValue(value) {
        if (value === null || value === undefined) return '—'
        if (typeof value === 'string') return value
        try { return JSON.stringify(value) } catch (err) { return String(value) }
      }

      function advancedBlock(item) {
        var adv = advanced[item.id] || {}
        // Caption on its own line, then a compact field row: at 360px the inline form
        // wrapped the second input to the next line and looked broken.
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, minWidth: 0 } },
          h('div', { style: Object.assign({}, mono, { fontSize: 11 }) }, t('advanced')),
          h('div', { style: actions },
            h('span', { style: hint }, t('maxSockets')),
            h('input', {
              placeholder: '6',
              value: adv.maxSockets || '',
              style: numInput,
              onChange: function (event) { setAdvancedValue(item.id, 'maxSockets', event.target.value) },
            }),
            h('span', { style: hint }, t('timeoutMs')),
            h('input', {
              placeholder: '90000',
              value: adv.timeoutMs || '',
              style: numInput,
              onChange: function (event) { setAdvancedValue(item.id, 'timeoutMs', event.target.value) },
            })))
      }

      function setAdvancedValue(id, key, value) {
        var next = Object.assign({}, advanced)
        next[id] = Object.assign({}, next[id] || {}, { [key]: value })
        setAdvanced(next)
      }

      // History ops come from the host as stable identifiers; translate the known ones
      // and fall back to the raw id so an unknown op is still readable.
      var OP_LABELS = {
        start: t('opStart'),
        apply: t('opApply'),
        rollback: t('opRollback'),
        'patch-verify': t('opPatchVerify'),
        'patch-repair': t('opPatchRepair'),
        'duplicate-instance': t('opDuplicate'),
        discover: t('opDiscover'),
      }
      function opLabel(op) {
        return OP_LABELS[op] || String(op || '-')
      }

      // Order matters: what the user came for (targets) first, then the compatibility
      // patches, then the audit trail.
      var historySection = data.history && data.history.length ? h('div', { style: box },
        h('div', { style: sectionTitle }, t('recent')),
        data.history.slice().reverse().map(function (entry, index) {
          return h('div', { key: 'h' + index, style: mono },
            String(entry.at || '').replace('T', ' ').slice(0, 19) + ' · ' + opLabel(entry.op) + ' · ' + (entry.routeId || '-') +
            ' · ' + (entry.ok === false ? t('failed') : t('ok')) + ' · ' + String(entry.detail || ''))
        })
      ) : null

      var patchesSection = data.patches && data.patches.length ? h('div', { style: box },
        h('div', { style: sectionTitle }, t('patchesTitle')),
        h('div', { style: Object.assign({}, hint, { marginBottom: 6 }) }, t('patchesHint')),
        data.patches.map(function (item) {
          return h('div', { key: 'p' + item.id, style: row },
            h('div', { style: rowHead },
              h('span', { style: name }, item.title),
              h('span', { style: tagTone(patchTone(item.status)) }, patchStatusLabel(item.status)),
              h('span', { style: mono }, item.package + (item.version ? '@' + item.version : ''))),
            item.detail ? h('div', { style: mono }, item.detail) : null,
            item.status === 'applied' && !item.backup && !item.ledger
              ? h('div', { style: mono }, t('patchExternal'))
              : null,
            h('div', { style: actions },
              item.status === 'pending' ? h('button', { style: btnPrimary, disabled: anyBusy, onClick: function () { patchAction(item, 'apply') } }, t('patchApply')) : null,
              item.status === 'applied' && (item.backup || item.ledger) ? h('button', { style: btn, disabled: anyBusy, onClick: function () { patchAction(item, 'revert') } }, t('patchRevert')) : null,
              h('button', { style: btn, disabled: anyBusy, onClick: function () { patchAction(item, 'verify') } }, t('patchVerify'))))
        })
      ) : null

      return h('div', {
        className: 'dsh-egress-root',
        role: 'region',
        'aria-label': t('title'),
        'aria-busy': anyBusy ? 'true' : 'false',
      },
        h('style', null, '.dsh-egress-root button:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #4d9fff);outline-offset:2px}'),
        h('div', { style: box },
          h('div', { style: headerBar },
            h('div', { style: { minWidth: 0 } },
              h('div', { role: 'heading', 'aria-level': 2, style: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: labelPrimary } }, t('title')),
              h('div', { style: Object.assign({}, hint, { marginTop: 4 }) }, t('subtitle'))),
            h('div', { style: actions },
              h('button', { style: btn, disabled: anyBusy, onClick: scan }, t('scan')),
              h('button', { style: btn, disabled: anyBusy, onClick: checkPorts }, t('portCheck')),
              h('button', { style: btn, disabled: anyBusy, onClick: function () { rollback(null) } }, t('rollbackLast'))
            )
          )),
        message ? h('div', { role: 'status', 'aria-live': 'polite', style: Object.assign({}, box, hint, { padding: '8px 12px' }) }, message) : null,
        profileWarning,
        (data.paused || []).map(function (entry, index) {
          return h('div', {
            key: 'p' + index,
            role: 'status',
            style: Object.assign({}, box, hint, { padding: '8px 12px', borderColor: 'var(--dsw-alias-state-warn-primary, #d29922)' }),
          }, '⏸ ' + t('pausedHint', { provider: entry.provider, until: entry.until }))
        }),
        (data.warnings || []).map(function (warn, index) {
          return h('div', {
            key: 'w' + index,
            role: 'alert',
            style: Object.assign({}, box, hint, { padding: '8px 12px', borderColor: 'var(--dsw-alias-state-warn-primary, #d29922)' }),
          }, '⚠ ' + warn.message)
        }),
        contractNotice(),
        driftItems().length
          ? h('div', {
              style: Object.assign({}, box, hint, { padding: '8px 12px', borderColor: 'var(--dsw-alias-state-warn-primary, #d29922)' }),
            },
              h('div', {}, '⚠ ' + t('driftWarning', { detail: driftItems().map(function (item) { return item.provider + ': ' + item.before + ' -> :' + item.listenPort }).join('; ') })),
              h('div', { style: actions },
                h('button', { style: btn, disabled: anyBusy, onClick: repairConfig }, t('repairConfig'))
              ))
          : null,
        h('div', { style: box },
          h('div', { style: sectionTitle }, t('found', { n: visible.length })),
          visible.length === 0 ? h('div', { style: mono }, t('noTargets')) : null,
          visible.map(function (item) {
            var live = listening[item.id]
            return h('div', { key: item.id, style: row },
              h('div', { style: rowHead },
                h('span', { style: tag }, kindLabel(item.kind)),
                h('span', { style: name }, item.name || item.id),
                item.confidence === 'low' ? h('span', { style: tagTone('warn') }, t('lowConfidence')) : null,
                item.routed ? h('span', { style: tagTone('info') }, t('routed')) : null,
              item.stale ? h('span', { style: tagTone('warn') }, t('staleRoute')) : null,
                item.guarded ? h('span', { style: tagTone('warn') }, t('guardedTag')) : null,
                live ? h('span', { style: tagTone(live.ok ? 'ok' : 'bad') }, (live.ok ? t('running', { port: live.port }) : t('down', { port: live.port }))) : null
              ),
              h('div', { style: mono },
                (item.target || '—') + (item.baseURL && item.baseURL !== item.target ? '  ' + item.baseURL : '')),
              item.stale ? h('div', { style: hint }, t('staleHint')) : null,
              metricsLine(item),
              h('div', { style: actions },
                isPatchable(item) && item.target ? h('input', {
                  placeholder: 'port',
                  value: ports[item.id] !== undefined ? ports[item.id] : (item.listenPort ? String(item.listenPort) : ''),
                  style: portInput,
                  onChange: function (event) {
                    var next = Object.assign({}, ports)
                    next[item.id] = event.target.value
                    setPorts(next)
                  },
                }) : null,
                isPatchable(item) && item.target ? h('select', {
                  title: t('proxyLabel'),
                  style: proxySelect,
                  value: proxies[item.id] !== undefined ? proxies[item.id] : (item.proxy || ''),
                  onChange: function (event) {
                    var nextProxy = Object.assign({}, proxies)
                    nextProxy[item.id] = event.target.value
                    setProxies(nextProxy)
                  },
                }, proxyOptions()) : null,
                isPatchable(item) && item.target ? h('button', {
                  style: btn,
                  disabled: anyBusy,
                  onClick: function () {
                    suggestPort(item).then(function (port) {
                      if (port) setMessage(t('portSuggested', { port: port }))
                    })
                  },
                }, t('findPort')) : null,
                item.stale ? h('input', {
                  placeholder: t('originPlaceholder'),
                  defaultValue: pendingOrigins[item.id] !== undefined ? pendingOrigins[item.id] : (item.originBaseURL || ''),
                  style: originInput,
                  onChange: function (event) { pendingOrigins[item.id] = event.target.value },
                }) : null,
                item.target ? h('button', { style: btn, disabled: anyBusy, onClick: function () { check(item) } }, t('check')) : null,
                item.bot ? h('select', {
                  title: t('proxyLabel'),
                  style: proxySelect,
                  value: botValue(item),
                  onChange: function (event) {
                    var nextProxy = Object.assign({}, proxies)
                    nextProxy[item.id] = event.target.value
                    setProxies(nextProxy)
                  },
                }, proxyOptions()) : null,
                item.bot ? h('button', {
                  style: Object.assign({}, btnPrimary, busy === item.id + ':bot' ? { opacity: 0.6 } : {}),
                  disabled: anyBusy,
                  onClick: function () { applyBot(item, botValue(item)) },
                }, t('botApply')) : null,
                isPatchable(item) && item.target ? h('button', { style: btn, disabled: anyBusy, onClick: function () { planItem(item) } }, t('plan')) : null,
                isPatchable(item) && item.target ? h('button', {
                  style: Object.assign({}, btnPrimary, busy === item.id + ':apply' ? { opacity: 0.6 } : {}),
                  disabled: anyBusy,
                  onClick: function () { applyItem(item) },
                }, t('apply')) : null,
                live && live.ok ? h('button', { style: btn, disabled: anyBusy, onClick: function () { testItem(item) } }, t('test')) : null,
                item.routed ? h('button', { style: btn, disabled: anyBusy, onClick: function () { rollback(item.id) } }, t('undo')) : null,
                !isPatchable(item) && !item.bot && item.target ? h('span', { style: mono }, t('needsManual')) : null
              ),
              item.bot ? h('div', { style: Object.assign({}, hint, { marginTop: 4 }) },
                t('botHint', { env: (botInfo(item) || {}).envVar || 'DSH_TELEGRAM_PROXY' }) + ' · ' +
                t('botSummary', {
                  patch: ((botInfo(item) || {}).patch || {}).status || '?',
                  proxy: botValue(item) || t('proxyDirect'),
                })) : null,
              isPatchable(item) && item.target ? advancedBlock(item) : null,
              previewBlock(item),

            )
          }),
          guarded.length ? h('div', { style: Object.assign({}, mono, { marginTop: 8 }) },
            t('guardedNote', { n: guarded.length }) + guarded.map(function (item) { return item.name }).join(', ')
          ) : null
        ),
        patchesSection,
        historySection
      )
    }

    exports.name = 'dsh-egress-router'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      var slots = ctx.slots
      if (!slots || typeof slots.register !== 'function') {
        console.warn('[egress-router] slots API unavailable; settings tab not registered')
        return
      }
      // Compatibility mode: if this host lost slots.inject, registering straight on the
      // slot name still puts the tab on screen (the probe is what told us to try).
      if (typeof slots.inject !== 'function') {
        try {
          slots.register({ name: 'settings.plugins.tab', id: 'egress-router', order: 120, label: function () { return t('tab') } }, EgressPanel)
          console.info('[egress-router] client applied without slots.inject (compatibility mode)')
        } catch (error) {
          console.warn('[egress-router] settings tab registration failed', error)
        }
        return
      }
      try {
        slots.inject('settings.plugins.tab', function () {
          return slots.register(
            { name: 'settings.plugins.tab', id: 'egress-router', order: 120, label: function () { return t('tab') } },
            EgressPanel
          )
        })
        console.info('[egress-router] client applied; settings tab registered on settings.plugins.tab')
      } catch (error) {
        console.warn('[egress-router] settings tab registration failed', error)
      }
    }
    return module.exports
  },
})

