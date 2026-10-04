/**
 * Plugin Drop — browser half.
 *
 * Contributes one sidebar entry and the full page it opens: a drop zone that
 * turns a dropped plugin folder (or .zip / .tgz) into an installation in this
 * profile. All work happens over this plugin's own same-origin
 * `/api/plugin-drop/*` routes, which stage the drop and then run the official
 * profile operation.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` and UI primitives the shell already provides as platform seeds. All
 * colour comes from theme variables, so the page follows the active scheme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-drop',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const DropIcon = primitives.IconDownloadOutlineRegular

    /** Dictionary namespace owned by this plugin. */
    const NS = 'pluginDrop'
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'plugin-drop'
    const inject = ['slots', 'locale']
    const API = '/api/plugin-drop'
    /** Directory noise that never belongs to a plugin. */
    const SKIP_DIRS = ['node_modules', '.git', '__MACOSX', '.idea', '.vscode', '.cache']
    const SKIP_FILES = ['desktop.ini', 'Thumbs.db', '.DS_Store']
    /** Raw bytes per drop, before base64: the host refuses a body over 96 MiB. */
    const MAX_RAW_BYTES = 64 * 1024 * 1024

    const DICT = {
      zh: {
        panel: '插件安装',
        title: '插件拖放安装器',
        lead: '把插件包拖进来，它会自动安装到当前 profile，并登记依赖与插件层——等价于命令行里的 dsh plugin add。',
        dropTitle: '把插件文件夹或压缩包拖到这里',
        dropSub: '松开即开始安装',
        dropHint: '支持解压后的插件文件夹（含 package.json）· .zip · .tgz / .tar.gz',
        chooseFolder: '选择文件夹',
        chooseArchive: '选择压缩包',
        reading: '正在读取拖入的内容…',
        staging: '正在暂存并识别插件包…',
        installing: '正在安装…',
        stageTitle: '已识别插件包',
        doneTitle: '安装完成',
        doneBody: '依赖与插件层都已写入 profile。启用了 HMR 的 profile 会自动重组，否则重启 DSH 后生效。',
        failedTitle: '安装失败',
        failedBody: '下面是 pnpm 或 Loader 的原始输出。',
        notStarted: '安装未开始',
        pathTitle: '从本地路径或包名安装',
        pathLead: '文件夹太大不便上传时，直接填绝对路径最快；也接受包名、Git 地址与 .tgz。',
        pathPlaceholder: '例如 C:\\Users\\you\\Downloads\\my-plugin',
        install: '安装',
        installedTitle: '当前 profile 的插件',
        none: '这个 profile 还没有安装任何插件。',
        loading: '读取中…',
        envTitle: '环境',
        remove: '卸载',
        confirmRemove: name => `从当前 profile 卸载 ${name}？`,
        plugin: '插件：',
        files: '文件：',
        stagedAt: '暂存到：',
        skippedSuffix: count => `（已跳过 ${count} 个打包噪声文件）`,
        unavailable: '这个安装器无法工作',
        unavailableBody: '它只在本机访问 DSH 时可用，请在运行 DSH 的机器上打开。',
        fileCount: count => `${count} 个`,
        emptyDrop: '拖入的内容里没有可安装的文件',
        tooLarge: size => `内容约 ${size} MiB，超过上传上限 64 MiB。请在下面直接填文件夹的绝对路径安装（不经过上传）。`,
        phaseReading: '读取拖入的文件',
        phaseStaging: '上传并暂存到磁盘',
        phaseInstalling: '执行官方安装操作',
        phaseDone: '完成',
        phaseFailed: '已停止',
        elapsed: seconds => `已用时 ${seconds} 秒`,
        stagedTitle: '已暂存的插件包',
        stagedEmpty: '暂存目录里还没有插件包。',
        stagedHostOld: '宿主半身还是旧版本，读不到暂存列表——重启 DSH 后这里会列出已暂存的内容。',
        stagedHint: '暂存目录就是插件的常驻位置（路径安装记成 link:），安装后请不要删除。',
        installStaged: '安装',
        deleteStaged: '删除',
        confirmDeleteStaged: name => `删除暂存的 ${name}？已安装的插件会因此失效。`,
        retriedByPath: '暂存凭据已失效，已改用暂存路径重试（这是重启后的正常情况）。',
        logPathLabel: '诊断日志',
        explainToken: '暂存凭据已失效（宿主重启，或那一次响应没送达）。插件包已经存在磁盘上，不会丢：请在下面「已暂存的插件包」里点「安装」。',
        explainNoProfile: '宿主半身读不到当前 profile。请重启 DSH；若仍如此，把「环境」区块的几行发我。',
        explainNoAdapter: '这台 DSH 里找不到官方安装适配器（lib/plugin-cli.js），安装操作无法执行。',
        explainTooLarge: '上传超过上限。请改用「从本地路径或包名安装」直接填绝对路径，不经过上传。',
        explainNotAPackage: '拖入的内容不是插件包：需要直接包含 package.json（可含 dsh.bundle.patch）。若它是压缩包，请确认没有多套一层目录。',
        explainNotStaged: '这个路径不在暂存目录里，出于安全拒绝删除。',
        explainNetwork: '请求没完成（超时或被中断）。可能是官方操作耗时过长或宿主正在重启；重试一次，或到「已暂存的插件包」里点「安装」。',
      },
      en: {
        panel: 'Install plugin',
        title: 'Plugin drop installer',
        lead: 'Drop a plugin package and it is installed into this profile, dependency and profile layer included — the same result as dsh plugin add.',
        dropTitle: 'Drop a plugin folder or archive here',
        dropSub: 'releasing starts the install',
        dropHint: 'an extracted plugin folder (with package.json) · .zip · .tgz / .tar.gz',
        chooseFolder: 'Choose folder',
        chooseArchive: 'Choose archive',
        reading: 'Reading what was dropped…',
        staging: 'Staging and identifying the package…',
        installing: 'Installing…',
        stageTitle: 'Package recognised',
        doneTitle: 'Installed',
        doneBody: 'The dependency and the profile layer are written. A profile with HMR recomposes by itself; otherwise restart DSH.',
        failedTitle: 'Install failed',
        failedBody: 'The original pnpm or Loader output follows.',
        notStarted: 'Nothing was installed',
        pathTitle: 'Install from a local path or package spec',
        pathLead: 'For a folder too large to upload, an absolute path is fastest. Package names, Git URLs and .tgz are accepted too.',
        pathPlaceholder: 'e.g. C:\\Users\\you\\Downloads\\my-plugin',
        install: 'Install',
        installedTitle: 'Plugins in this profile',
        none: 'This profile has no plugins installed yet.',
        loading: 'Loading…',
        envTitle: 'Environment',
        remove: 'Remove',
        confirmRemove: name => `Remove ${name} from this profile?`,
        plugin: 'Plugin: ',
        files: 'Files: ',
        stagedAt: 'Staged at: ',
        skippedSuffix: count => ` (${count} packaging-noise files skipped)`,
        unavailable: 'This installer cannot work',
        unavailableBody: 'It only answers requests from the machine DSH runs on.',
        fileCount: count => `${count}`,
        emptyDrop: 'the drop held no installable files',
        tooLarge: size => `About ${size} MiB, over the 64 MiB upload limit. Use the absolute-path box below instead; it does not upload.`,
        phaseReading: 'Reading the dropped files',
        phaseStaging: 'Uploading and staging to disk',
        phaseInstalling: 'Running the official install operation',
        phaseDone: 'Done',
        phaseFailed: 'Stopped',
        elapsed: seconds => `${seconds}s elapsed`,
        stagedTitle: 'Staged packages',
        stagedEmpty: 'Nothing is staged yet.',
        stagedHostOld: 'The host half is still the old build and cannot list staged packages — restart DSH and this section will show what is staged.',
        stagedHint: 'A staged directory is where a path install keeps living (recorded as link:), so do not delete it after installing.',
        installStaged: 'Install',
        deleteStaged: 'Delete',
        confirmDeleteStaged: name => `Delete the staged copy of ${name}? An installed plugin that links to it will break.`,
        retriedByPath: 'The staging token had expired, so the install was retried by path — the normal case after a restart.',
        logPathLabel: 'Diagnostic log',
        explainToken: 'The staging token expired (the host restarted, or that response never arrived). The package is still on disk: use Install in the staged list below.',
        explainNoProfile: 'The host half cannot read the current profile. Restart DSH; if it persists, send me the Environment lines.',
        explainNoAdapter: 'This DSH has no official plugin adapter (lib/plugin-cli.js), so no install can run.',
        explainTooLarge: 'The upload exceeded the limit. Use the absolute-path box instead; it does not upload.',
        explainNotAPackage: 'The dropped content is not a plugin package: it must contain package.json directly.',
        explainNotStaged: 'That path is not inside the staging directory, so deletion was refused.',
        explainNetwork: 'The request did not finish (timed out or interrupted). Retry, or use Install in the staged list below.',
      },
    }

    const CSS = `
.pdrop_root{display:flex;flex-direction:column;gap:16px;max-width:900px;padding:24px 24px 48px;margin:0 auto;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.pdrop_h1{font-size:19px;font-weight:650;margin:0}
.pdrop_lead{margin:0;color:var(--dsw-alias-label-secondary)}
.pdrop_zone{border:2px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);padding:34px 20px;text-align:center;cursor:pointer;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,background .15s}
.pdrop_zone.hot{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}
.pdrop_zone:hover{border-color:var(--dsw-alias-state-business-primary)}
.pdrop_big{font-size:16px;font-weight:600;margin-bottom:4px}
.pdrop_sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.pdrop_hint{color:var(--dsw-alias-label-caption);font-size:12px;margin-top:12px}
.pdrop_section{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);padding:14px 16px;background:var(--dsw-alias-bg-layer-1)}
.pdrop_h2{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:0 0 8px}
.pdrop_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pdrop_btn{font:inherit;font-size:12.5px;padding:6px 13px;border-radius:var(--dsw-radius-md,9px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.pdrop_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.pdrop_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.pdrop_btn.ghost{border:none;background:none;color:var(--dsw-alias-label-tertiary);padding:4px 6px}
.pdrop_btn.ghost:hover{color:var(--dsw-alias-state-error-primary)}
.pdrop_btn:disabled{opacity:.5;cursor:default}
.pdrop_input{flex:1 1 320px;min-width:0;font:inherit;font-size:12.5px;padding:7px 11px;border-radius:var(--dsw-radius-md,9px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdrop_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.pdrop_log{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,9px);padding:10px 12px;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.pdrop_note{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,9px);padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}
.pdrop_note.ok{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l2))}
.pdrop_note.err{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2))}
.pdrop_note.warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2))}
.pdrop_noteTitle{font-weight:600;margin-bottom:3px}
.pdrop_mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.pdrop_table{width:100%;border-collapse:collapse;font-size:12.5px}
.pdrop_table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:11.5px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pdrop_table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.pdrop_meta{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.pdrop_meta dt{color:var(--dsw-alias-label-caption)}
.pdrop_meta dd{margin:0;word-break:break-all}
.pdrop_progress{display:flex;flex-direction:column;gap:6px}
.pdrop_progressHead{display:flex;justify-content:space-between;gap:12px;font-size:12.5px}
.pdrop_bar{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));overflow:hidden;position:relative}
.pdrop_barFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .25s ease}
.pdrop_barFill.indeterminate{width:38%;animation:pdrop-slide 1.15s ease-in-out infinite}
.pdrop_barFill.ok{background:var(--dsw-alias-state-success-primary)}
.pdrop_barFill.err{background:var(--dsw-alias-state-error-primary)}
@keyframes pdrop-slide{0%{margin-left:-40%}50%{margin-left:30%}100%{margin-left:100%}}
.pdrop_tag{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}
.pdrop_tag.warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
.pdrop_hidden{display:none}
`

    /**
     * Turn a host or network failure into something the reader can act on.
     *
     * The host answers with English diagnostics; the raw text is always kept
     * beside the explanation, because it is what a bug report needs.
     */
    function explainError(message, t) {
      const text = String(message ?? '')
      if (/no longer available/u.test(text)) return t('explainToken')
      if (/could not work out which profile/u.test(text)) return t('explainNoProfile')
      if (/could not find the DSH plugin adapter/u.test(text)) return t('explainNoAdapter')
      if (/larger than the/u.test(text)) return t('explainTooLarge')
      if (/no package\.json|not a plugin package|not valid JSON/u.test(text)) return t('explainNotAPackage')
      if (/is not inside the staging directory/u.test(text)) return t('explainNotStaged')
      if (/aborted|AbortError|Failed to fetch|NetworkError/u.test(text)) return t('explainNetwork')
      return null
    }

    /** Read a JSON route, turning any non-JSON failure into a message. */
    async function api(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)
      try {
        const response = await fetch(`${API}${path}`, { ...options, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 300) }
        }
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-drop': '1' },
      body: JSON.stringify(body),
    })

    const skipped = relative => {
      const parts = relative.replace(/\\/gu, '/').split('/')
      return parts.some(part => SKIP_DIRS.includes(part)) || SKIP_FILES.includes(parts[parts.length - 1])
    }

    function toBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      return btoa(binary)
    }

    /** Walk one dropped entry, so a dropped folder arrives with its tree intact. */
    async function walkEntry(entry, prefix, out) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
        out.push({ path: prefix + entry.name, file })
        return
      }
      if (!entry.isDirectory) return
      if (SKIP_DIRS.includes(entry.name)) return
      const reader = entry.createReader()
      for (;;) {
        // readEntries yields batches; it must be called until it returns none.
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        if (batch.length === 0) return
        for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out)
      }
    }

    /** Everything a drop carried, as relative paths plus files. */
    async function collect(dataTransfer) {
      const items = Array.from(dataTransfer.items ?? []).filter(item => item.kind === 'file')
      const entries = items.map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)).filter(Boolean)
      const out = []
      if (entries.length > 0) {
        for (const entry of entries) await walkEntry(entry, '', out)
        return out
      }
      for (const file of Array.from(dataTransfer.files ?? [])) out.push({ path: file.webkitRelativePath || file.name, file })
      return out
    }

    /** The dropped files as the host's staging payload, reporting bytes as they are read. */
    async function encode(files, onProgress) {
      const kept = files.filter(file => !skipped(file.path))
      if (kept.length === 0) throw new Error('empty drop')
      const total = kept.reduce((sum, file) => sum + file.file.size, 0)
      if (total > MAX_RAW_BYTES) throw new Error(`too large:${Math.round(total / 1048576)}`)
      const payload = []
      let read = 0
      for (const file of kept) {
        payload.push({ path: file.path, data: toBase64(await file.file.arrayBuffer()) })
        read += file.file.size
        onProgress?.(read, total)
      }
      return payload
    }

    function Message({ note, t }) {
      if (note === null) return null
      const title = note.kind === 'too-large' ? t('notStarted') : note.title
      const body = note.kind === 'too-large' ? t('tooLarge', note.size) : note.body
      const lines = note.lines ?? []
      return h('div', { className: `pdrop_note ${note.kind === 'error' || note.kind === 'too-large' ? 'err' : note.kind === 'warn' ? 'warn' : 'ok'}` },
        h('div', { className: 'pdrop_noteTitle' }, title),
        body === undefined ? null : h('div', { className: 'pdrop_lead' }, body),
        lines.map((line, index) => h('div', { key: index, className: 'pdrop_mono' }, line)),
        (note.warnings ?? []).map((warning, index) => h('div', { key: `w${index}`, className: 'pdrop_mono', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `⚠ ${warning}`)))
    }

    function PanelIcon({ size }) {
      return DropIcon === undefined ? h('span', null, '⇩') : h(DropIcon, { size })
    }

    /** Bytes in the units a person reads. */
    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * The bar for the operation in flight.
     *
     * Reading the drop knows its own extent, so that phase is determinate;
     * uploading and the profile operation cannot report progress through their
     * APIs, so they show an indeterminate bar with elapsed time rather than a
     * percentage that would be invented.
     */
    function Progress({ progress, t }) {
      if (progress === null) return null
      const determinate = typeof progress.ratio === 'number'
      const percent = determinate ? Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100) : null
      const seconds = Math.max(0, Math.round(((progress.endedAt ?? Date.now()) - progress.startedAt) / 1000))
      const tone = progress.phase === 'failed' ? 'err' : progress.phase === 'done' ? 'ok' : ''
      const fillClass = ['pdrop_barFill', tone, determinate ? '' : 'indeterminate'].filter(Boolean).join(' ')
      return h('div', { className: 'pdrop_section' },
        h('div', { className: 'pdrop_progress' },
          h('div', { className: 'pdrop_progressHead' },
            h('span', null, progress.label),
            h('span', { className: 'pdrop_mono', style: { color: 'var(--dsw-alias-label-tertiary)' } },
              [percent === null ? null : `${percent}%`, progress.detail ?? null, t('elapsed', seconds)].filter(Boolean).join(' · '))),
          h('div', { className: 'pdrop_bar', role: 'progressbar', 'aria-valuenow': percent ?? undefined, 'aria-label': progress.label },
            h('div', { className: fillClass, style: determinate ? { width: `${percent}%` } : undefined }))))
    }

    function InstallerPage(props) {
      const t = props.t
      const [summary, setSummary] = useState(null)
      const [problem, setProblem] = useState(null)
      const [diagnosis, setDiagnosis] = useState(null)
      const [progress, setProgress] = useState(null)
      const [note, setNote] = useState(null)
      const [log, setLog] = useState('')
      const [busy, setBusy] = useState(false)
      const [hot, setHot] = useState(false)
      const [spec, setSpec] = useState('')
      const depth = useRef(0)
      const folderPicker = useRef(null)
      const filePicker = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const next = await api('/state')
          if (next.available === false) {
            setProblem(next.problem ?? 'unknown')
            setDiagnosis(next.diagnosis ?? null)
          } else {
            setProblem(null)
            setDiagnosis(null)
            setSummary(next)
          }
        } catch (cause) {
          setProblem(cause.message)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      /** Poll one background operation until it settles. */
      const follow = useCallback(async (jobId, title) => {
        setLog('')
        for (;;) {
          let job
          try {
            job = await api(`/job?id=${encodeURIComponent(jobId)}`)
          } catch (cause) {
            setNote({ kind: 'error', title: t('failedTitle'), body: cause.message })
            return null
          }
          setLog(job.output ?? '')
          if (job.state !== 'running') return job
          await new Promise(resolve => setTimeout(resolve, 600))
        }
      }, [t])

      const install = useCallback(async (started, label) => {
        setBusy(true)
        setNote(null)
        try {
          const job = await follow(started.jobId, label)
          if (job === null) {
            setProgress(current => (current === null ? null : { ...current, phase: 'failed', label: t('phaseFailed'), endedAt: Date.now() }))
            return
          }
          if (job.state === 'done') {
            setProgress(current => ({ phase: 'done', label: t('phaseDone'), ratio: 1, startedAt: current?.startedAt ?? Date.now(), endedAt: Date.now() }))
            setNote({ kind: 'ok', title: t('doneTitle'), body: t('doneBody') })
          } else {
            setProgress(current => (current === null ? null : { ...current, phase: 'failed', label: t('phaseFailed'), endedAt: Date.now() }))
            setNote({ kind: 'error', title: `${t('failedTitle')} (exit ${job.exitCode})`, body: t('failedBody') })
          }
          await refresh()
        } finally {
          setBusy(false)
        }
      }, [follow, refresh, t])

      const installDrop = useCallback(async dataTransfer => {
        if (busy) return
        setBusy(true)
        setNote(null)
        setLog('')
        setProgress({ phase: 'reading', label: t('phaseReading'), ratio: 0, startedAt: Date.now() })
        try {
          const files = await collect(dataTransfer)
          const payload = await encode(files, (read, total) => setProgress(current => (current === null ? current : {
            ...current,
            ratio: total === 0 ? 0 : read / total,
            detail: `${formatBytes(read)} / ${formatBytes(total)}`,
          })))
          setProgress({ phase: 'staging', label: t('phaseStaging'), ratio: null, startedAt: Date.now() })
          const staged = await post('/stage', { files: payload })
          const info = staged.inspection
          setNote({
            kind: 'ok',
            title: t('stageTitle'),
            lines: [
              `${t('plugin')}${info.name}${info.version === null || info.version === undefined ? '' : ` @ ${info.version}`}`,
              `${t('files')}${t('fileCount', staged.fileCount)}${staged.skipped > 0 ? t('skippedSuffix', staged.skipped) : ''}`,
              `${t('stagedAt')}${staged.installPath}`,
            ],
            warnings: info.warnings ?? [],
          })
          setProgress({ phase: 'installing', label: t('phaseInstalling'), ratio: null, startedAt: Date.now() })
          let started
          try {
            started = await post('/install', { token: staged.token })
          } catch (cause) {
            // The token is memory-only, so a restart between the two calls (or a
            // response that never arrived) leaves the staged directory — which is
            // still a perfectly good absolute-path install.
            void cause
            setNote(current => ({
              ...(current ?? { kind: 'ok', title: t('stageTitle') }),
              warnings: [...(current?.warnings ?? []), t('retriedByPath')],
            }))
            started = await post('/install', { spec: staged.installPath })
          }
          await install(started, t('installing'))
        } catch (cause) {
          const message = String(cause.message ?? cause)
          setProgress(current => (current === null ? null : { ...current, phase: 'failed', label: t('phaseFailed'), endedAt: Date.now() }))
          if (message === 'empty drop') setNote({ kind: 'error', title: t('notStarted'), body: t('emptyDrop') })
          else if (message.startsWith('too large:')) setNote({ kind: 'too-large', size: Number(message.slice('too large:'.length)) })
          else {
            const explanation = explainError(message, t)
            setNote({ kind: 'error', title: t('notStarted'), body: explanation ?? message, lines: explanation === null ? [] : [message] })
          }
          setBusy(false)
        }
      }, [busy, install, t])

      /** Install a package that is already staged, addressed by its path. */
      const installStaged = useCallback(async staged => {
        if (busy) return
        setBusy(true)
        setNote(null)
        setProgress({ phase: 'installing', label: t('phaseInstalling'), ratio: null, startedAt: Date.now() })
        try {
          const started = await post('/install', { spec: staged.installPath })
          await install(started, t('installing'))
        } catch (cause) {
          const message = String(cause.message ?? cause)
          setProgress(current => (current === null ? null : { ...current, phase: 'failed', label: t('phaseFailed'), endedAt: Date.now() }))
          const explanation = explainError(message, t)
          setNote({ kind: 'error', title: t('notStarted'), body: explanation ?? message, lines: explanation === null ? [] : [message] })
          setBusy(false)
        }
      }, [busy, install, t])

      const deleteStaged = useCallback(async staged => {
        if (busy || !window.confirm(t('confirmDeleteStaged', staged.name))) return
        setBusy(true)
        try {
          await post('/staged/delete', { path: staged.directory })
          await refresh()
        } catch (cause) {
          setNote({ kind: 'error', title: t('notStarted'), body: String(cause.message ?? cause) })
        } finally {
          setBusy(false)
        }
      }, [busy, refresh, t])

      const installSpec = useCallback(async () => {
        const value = spec.trim()
        if (value === '' || busy) return
        setBusy(true)
        setNote(null)
        try {
          const started = await post('/install', { spec: value })
          await install(started, t('installing'))
        } catch (cause) {
          setNote({ kind: 'error', title: t('notStarted'), body: String(cause.message ?? cause) })
          setBusy(false)
        }
      }, [busy, install, spec, t])

      const remove = useCallback(async name => {
        if (busy || !window.confirm(t('confirmRemove', name))) return
        setBusy(true)
        setNote(null)
        try {
          const started = await post('/remove', { name })
          await install(started, t('installing'))
        } catch (cause) {
          setNote({ kind: 'error', title: t('notStarted'), body: String(cause.message ?? cause) })
          setBusy(false)
        }
      }, [busy, install, t])

      const pick = useCallback(async event => {
        const files = Array.from(event.target.files ?? []).map(file => ({ path: file.webkitRelativePath || file.name, file }))
        event.target.value = ''
        if (files.length > 0) await installDrop({ items: [], files })
      }, [installDrop])

      const dropEvents = {
        onDragEnter: event => {
          event.preventDefault()
          depth.current += 1
          setHot(true)
        },
        onDragOver: event => {
          event.preventDefault()
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
        },
        onDragLeave: event => {
          event.preventDefault()
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setHot(false)
        },
        onDrop: event => {
          event.preventDefault()
          depth.current = 0
          setHot(false)
          if (!busy) void installDrop(event.dataTransfer)
        },
      }

      if (problem !== null) {
        // The host reports what it could see, so an unusable page explains itself
        // instead of leaving the reader with nothing to report.
        const lines = diagnosis === null ? [] : Object.entries(diagnosis).map(([key, value]) => `${key}: ${String(value)}`)
        return h('div', { className: 'pdrop_root' }, h(Message, { note: { kind: 'error', title: t('unavailable'), body: problem === 'unknown' ? t('unavailableBody') : problem, lines }, t }))
      }

      return h('div', { className: 'pdrop_root' },
        h('div', null,
          h('h1', { className: 'pdrop_h1' }, t('title')),
          h('p', { className: 'pdrop_lead' }, t('lead'))),
        h(Progress, { progress, t }),
        h(Message, { note, t }),
        h('div', { className: `pdrop_zone${hot ? ' hot' : ''}`, ...dropEvents, onClick: () => { if (!busy) folderPicker.current?.click() } },
          h('div', { className: 'pdrop_big' }, busy ? t('installing') : t('dropTitle')),
          h('div', { className: 'pdrop_sub' }, busy ? '' : t('dropSub')),
          h('div', { className: 'pdrop_hint' }, t('dropHint')),
          h('div', { className: 'pdrop_row', style: { justifyContent: 'center', marginTop: '14px' } },
            h('button', { className: 'pdrop_btn', disabled: busy, onClick: event => { event.stopPropagation(); folderPicker.current?.click() } }, t('chooseFolder')),
            h('button', { className: 'pdrop_btn', disabled: busy, onClick: event => { event.stopPropagation(); filePicker.current?.click() } }, t('chooseArchive'))),
          h('input', { ref: folderPicker, type: 'file', multiple: true, webkitdirectory: '', className: 'pdrop_hidden', onChange: pick }),
          h('input', { ref: filePicker, type: 'file', multiple: true, accept: '.zip,.tgz,.gz', className: 'pdrop_hidden', onChange: pick })),
        log === '' ? null : h('div', { className: 'pdrop_section' }, h('h2', { className: 'pdrop_h2' }, t('installing')), h('div', { className: 'pdrop_log' }, log)),
        h('div', { className: 'pdrop_section' },
          h('h2', { className: 'pdrop_h2' }, t('pathTitle')),
          h('p', { className: 'pdrop_lead', style: { marginBottom: '10px' } }, t('pathLead')),
          h('div', { className: 'pdrop_row' },
            h('input', { className: 'pdrop_input', type: 'text', value: spec, placeholder: t('pathPlaceholder'), disabled: busy, onChange: event => setSpec(event.target.value), onKeyDown: event => { if (event.key === 'Enter') void installSpec() } }),
            h('button', { className: 'pdrop_btn primary', disabled: busy, onClick: () => void installSpec() }, t('install')))),
        h('div', { className: 'pdrop_section' },
          h('h2', { className: 'pdrop_h2' }, t('stagedTitle')),
          summary === null
            ? h('div', { className: 'pdrop_lead' }, t('loading'))
            : summary.staged === undefined
              // A host half older than this bundle cannot list what is staged;
              // saying "nothing is staged" there would be a lie.
              ? h('div', { className: 'pdrop_lead' }, t('stagedHostOld'))
              : summary.staged.length === 0
                ? h('div', { className: 'pdrop_lead' }, t('stagedEmpty'))
                : h('div', null,
                h('table', { className: 'pdrop_table' },
                  h('thead', null, h('tr', null, h('th', null, 'name'), h('th', null, 'staged at'), h('th', null, ''))),
                  h('tbody', null, (summary.staged ?? []).map(staged => h('tr', { key: staged.directory },
                    h('td', { className: 'pdrop_mono' },
                      staged.name,
                      staged.version === null || staged.version === undefined ? null : ` @ ${staged.version}`,
                      staged.hasBundlePatch ? null : h('span', { className: 'pdrop_tag warn' }, 'no dsh.bundle')),
                    h('td', { className: 'pdrop_mono', style: { color: 'var(--dsw-alias-label-tertiary)' } }, staged.installPath),
                    h('td', { style: { whiteSpace: 'nowrap' } },
                      h('button', { className: 'pdrop_btn primary', disabled: busy, onClick: () => void installStaged(staged) }, t('installStaged')),
                      ' ',
                      h('button', { className: 'pdrop_btn ghost', disabled: busy, onClick: () => void deleteStaged(staged) }, t('deleteStaged'))))))),
                h('p', { className: 'pdrop_lead', style: { marginTop: '8px', fontSize: '12px' } }, t('stagedHint')))),
        h('div', { className: 'pdrop_section' },
          h('h2', { className: 'pdrop_h2' }, t('installedTitle')),
          summary === null
            ? h('div', { className: 'pdrop_lead' }, t('loading'))
            : summary.dependencies.length === 0
              ? h('div', { className: 'pdrop_lead' }, t('none'))
              : h('table', { className: 'pdrop_table' },
                h('thead', null, h('tr', null, h('th', null, 'name'), h('th', null, 'source'), h('th', null, 'kind'), h('th', null, ''))),
                h('tbody', null, summary.dependencies.map(dependency => h('tr', { key: dependency.name },
                  h('td', { className: 'pdrop_mono' }, dependency.name),
                  h('td', { className: 'pdrop_mono', style: { color: 'var(--dsw-alias-label-tertiary)' } }, dependency.spec),
                  h('td', null, dependency.isBundle ? 'bundle' : 'dependency'),
                  // DSH's own bundles are what the app runs on; removing one breaks the install.
                  h('td', null, dependency.name.startsWith('@deepseek-ai/') ? null : h('button', { className: 'pdrop_btn ghost', disabled: busy, onClick: () => void remove(dependency.name) }, t('remove')))))))),
        h('div', { className: 'pdrop_section' },
          h('h2', { className: 'pdrop_h2' }, t('envTitle')),
          summary === null ? null : h('dl', { className: 'pdrop_meta' },
            h('dt', null, 'profile'), h('dd', { className: 'pdrop_mono' }, summary.profile),
            h('dt', null, 'profile dir'), h('dd', { className: 'pdrop_mono' }, summary.profileDirectory),
            h('dt', null, 'DSH home'), h('dd', { className: 'pdrop_mono' }, summary.home),
            h('dt', null, 'staging'), h('dd', { className: 'pdrop_mono' }, summary.stagingRoot),
            h('dt', null, t('logPathLabel')), h('dd', { className: 'pdrop_mono' }, summary.logPath ?? '—'),
            h('dt', null, 'http'), h('dd', { className: 'pdrop_mono' }, `${API}/`))))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'plugin-drop: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-plugin-drop')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'plugin-drop: styles')

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, InstallerPage)
      })
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-plugin-drop'
    return module.exports
  },
})
