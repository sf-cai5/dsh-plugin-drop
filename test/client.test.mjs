/**
 * Checks for the browser half: the ModuleLoader contract the shell enforces,
 * the two slot registrations that make the page reachable, and a render of the
 * page component through React with a minimal hook dispatcher.
 *
 * React comes from the application's own node_modules — the same copy the
 * shell's seed table hands the bundle at runtime. `react-dom` is not shipped as
 * a module (it lives inside the prebuilt front end bundle), so the component is
 * invoked directly and its element tree is walked instead.
 *
 * Run with: node test/client.test.mjs
 * React is read from the installed DSH application; set `DSH_APP_DIR` when it
 * is not in a default location (the error says exactly what to set).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The installed DSH application directory: `DSH_APP_DIR`, else the usual places. */
function resolveAppDirectory() {
  const candidates = [
    process.env.DSH_APP_DIR,
    process.env.LOCALAPPDATA === undefined ? null : path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH NEXT', 'resources', 'app'),
    process.env.ProgramFiles === undefined ? null : path.join(process.env.ProgramFiles, 'DSH NEXT', 'resources', 'app'),
    '/Applications/DSH NEXT.app/Contents/Resources/app',
    '/opt/DSH NEXT/resources/app',
  ].filter(candidate => typeof candidate === 'string' && candidate !== '');
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'node_modules', 'react', 'package.json'))) return candidate;
  }
  throw new Error(`could not find the DSH application directory (looked for node_modules/react under ${candidates.join(', ')}); set DSH_APP_DIR to <install>/resources/app`);
}

const APP = resolveAppDirectory();
const require = createRequire(path.join(APP, 'package.json'));
const React = require('react');

let passed = 0;
const check = (label, run) => {
  run();
  passed += 1;
  console.log(`  ok  ${label}`);
};

// The bundle registers itself with the shell's loader; capture that registration.
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load: value => {
      assert.equal(registration, null, 'a bundle must call load() exactly once');
      registration = value;
    },
  },
};
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } };

await import(pathToFileURL(path.join(import.meta.dirname, '..', 'client.js')).href);

/**
 * Render one function component by supplying the hooks it calls.
 * `seed` supplies the value of a `useState` cell by call order, which is how the
 * loaded and unavailable states are reached without a live host.
 */
function renderComponent(component, props, seed = []) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const slot = internals.ReactCurrentDispatcher;
  const previous = slot.current;
  const cells = [];
  const remaining = [...seed];
  let cursor = 0;
  slot.current = {
    useState: initial => {
      const index = cursor++;
      const supplied = remaining[index];
      if (supplied !== undefined) cells[index] = supplied;
      else if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], () => {}];
    },
    useRef: initial => {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useCallback: callback => callback,
    useMemo: factory => factory(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useReducer: (reducer, initial) => [initial, () => {}],
    useContext: () => undefined,
    useDebugValue: () => {},
    useId: () => 'test',
  };
  try {
    return component(props);
  } finally {
    slot.current = previous;
  }
}

/** Every string in an element tree, in order. Hook-free child components are invoked. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === 'object' && typeof node.type === 'function') {
    textOf(node.type(node.props), out);
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) {
    const children = node.props.children;
    if (Array.isArray(children)) for (const child of children) textOf(child, out);
    else textOf(children, out);
  }
  return out;
}

/** Every class name in an element tree, expanding hook-free child components. */
function classesOf(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) classesOf(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    classesOf(node.type(node.props), out);
    return out;
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const child of children) classesOf(child, out);
  else classesOf(children, out);
  return out;
}

const dictionaries = {};
const registered = [];
const effects = [];
const ctx = {
  locale: {
    bind: namespace => (key, ...args) => {
      const entry = dictionaries[namespace]?.zh?.[key];
      return typeof entry === 'function' ? entry(...args) : (entry ?? key);
    },
    register: (namespace, table) => {
      dictionaries[namespace] = table;
    },
  },
  effect: callback => {
    const disposer = callback();
    effects.push(disposer);
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  },
  slots: {
    // `inject` runs the callback; the shipped page uses a generator, whose body
    // runs on the first next() and must reach its end.
    inject: (key, callback) => {
      const result = callback();
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        let step = result.next();
        while (step.done !== true) step = result.next();
      }
      return () => {};
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
};

console.log('plugin-drop client tests');

check('the bundle registers under its package name', () => {
  assert.equal(registration.id, 'dsh-plugin-drop');
  assert.equal(typeof registration.factory, 'function');
});

let bundle = null;
check('the factory returns the CJS shape the loader requires', () => {
  bundle = registration.factory(specifier => {
    if (specifier === 'react') return React;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { IconDownloadOutlineRegular: () => null };
    throw new Error(`unexpected require(${specifier})`);
  });
  assert.equal(typeof bundle.apply, 'function');
  assert.equal(bundle.name, 'dsh-plugin-drop');
  assert.deepEqual(bundle.inject, ['slots', 'locale']);
});

check('apply() installs its dictionary and its styles', () => {
  bundle.apply(ctx);
  assert.equal(typeof dictionaries.pluginDrop.zh.panel, 'string');
  assert.equal(typeof dictionaries.pluginDrop.en.panel, 'string');
  assert.equal(effects.length, 2, 'one dictionary effect and one style effect');
  const style = effects[1];
  assert.equal(typeof style, 'function', 'the style effect returns its disposer');
});

check('the sidebar entry and its main panel share one id', () => {
  const sidebar = registered.find(entry => entry.options.name === 'sidebar.panellist');
  const main = registered.find(entry => entry.options.name === 'main');
  assert.equal(sidebar.options.id, 'plugin-drop');
  assert.equal(main.options.key, sidebar.options.id, 'selecting the entry opens the panel keyed by that id');
  assert.equal(typeof sidebar.options.order, 'number');
  assert.equal(sidebar.options.label(), '插件安装');
  assert.equal(main.options.locale, 'pluginDrop');
  assert.equal(typeof main.component, 'function');
});

check('the sidebar icon renders through the shell primitives', () => {
  const sidebar = registered.find(entry => entry.options.name === 'sidebar.panellist');
  const element = sidebar.component({ size: 16, active: false });
  assert.equal(element.type({ size: 16 }), null, 'the primitive component is reached');
});

check('the page renders its drop zone, routes and sections', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const tree = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') });
  const text = textOf(tree).join('\n');
  assert.match(text, /插件拖放安装器/u);
  assert.match(text, /把插件文件夹或压缩包拖到这里/u);
  assert.match(text, /从本地路径或包名安装/u);
  assert.match(text, /当前 profile 的插件/u);
  const classes = classesOf(tree);
  assert.ok(classes.includes('pdrop_zone'), 'the drop surface is present');
  assert.ok(classes.includes('pdrop_input'), 'the absolute-path box is present');
  assert.ok(!classes.includes('pdrop_log'), 'no log panel before an install starts');
});

check('the loaded state shows the profile, its plugins and the route', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const summary = {
    available: true,
    profile: 'desktop',
    profileDirectory: 'E:\\dsh\\home\\profiles\\desktop',
    home: 'E:\\dsh\\home',
    stagingRoot: 'E:\\dsh\\home\\plugin-drop\\staged',
    bundles: ['@deepseek-ai/dsh-base', 'dsh-whatever'],
    dependencies: [
      { name: '@deepseek-ai/dsh-base', spec: '0.2.0-rc.2', isBundle: true },
      { name: 'dsh-whatever', spec: 'link:C:/tmp/dsh-whatever', isBundle: true },
    ],
  };
  // Cell order: summary, problem, diagnosis, progress, note, log, busy, hot, spec.
  const tree = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [summary]);
  const text = textOf(tree).join('\n');
  assert.match(text, /desktop/u);
  assert.match(text, /plugin-drop[\\/]staged/u);
  assert.match(text, /dsh-whatever/u);
  assert.match(text, /api\/plugin-drop/u);
  assert.equal(textOf(tree).filter(line => line === '卸载').length, 1, 'only the non-shipped dependency offers removal');
});

check('a staged package is offered for install and deletion', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const summary = {
    available: true,
    profile: 'desktop',
    profileDirectory: 'E:\\dsh\\home\\profiles\\desktop',
    home: 'E:\\dsh\\home',
    stagingRoot: 'E:\\dsh\\home\\plugin-drop\\staged',
    logPath: 'E:\\dsh\\home\\plugin-drop\\plugin-drop.log',
    bundles: [],
    dependencies: [],
    staged: [
      { id: 'dsh-purge', directory: 'E:\\dsh\\home\\plugin-drop\\staged\\dsh-purge', installPath: 'E:\\dsh\\home\\plugin-drop\\staged\\dsh-purge\\dsh-purge-master', name: 'dsh-purge', version: '1.1.37', hasBundlePatch: true, hasClient: true, warnings: [], stagedAt: '2026-10-04T03:39:04.000Z' },
      { id: 'plain', directory: 'E:\\dsh\\home\\plugin-drop\\staged\\plain', installPath: 'E:\\dsh\\home\\plugin-drop\\staged\\plain', name: 'plain-dep', version: null, hasBundlePatch: false, hasClient: false, warnings: [], stagedAt: null },
    ],
  };
  const tree = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [summary]);
  const text = textOf(tree).join('\n')
  const flat = textOf(tree).join('')
  assert.match(text, /已暂存的插件包/u);
  assert.match(flat, /dsh-purge @ 1\.1\.37/u);
  assert.match(flat, /plain-dep/u);
  assert.match(text, /no dsh\.bundle/u, 'a package without a bundle patch is flagged');
  assert.equal(textOf(tree).filter(line => line === '安装').length >= 2, true, 'each staged package can be installed by path');
  assert.equal(textOf(tree).filter(line => line === '删除').length, 2);
  assert.match(text, /plugin-drop\.log/u, 'the diagnostic log path is shown');
});

check('an older host half is named instead of claiming nothing is staged', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const summary = {
    available: true,
    profile: 'desktop',
    profileDirectory: 'E:\\dsh\\home\\profiles\\desktop',
    home: 'E:\\dsh\\home',
    stagingRoot: 'E:\\dsh\\home\\plugin-drop\\staged',
    bundles: [],
    dependencies: [],
    // No `staged` key: this is what an older host half answers.
  };
  const text = textOf(renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [summary])).join('\n');
  assert.match(text, /宿主半身还是旧版本/u);
  assert.doesNotMatch(text, /暂存目录里还没有插件包/u);
});

check('the progress bar reports phases and marks the indeterminate ones', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const running = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [
    null, null, null,
    { phase: 'installing', label: '执行官方安装操作', ratio: null, startedAt: Date.now() - 4000 },
  ]);
  const runningText = textOf(running).join('\n');
  assert.match(runningText, /执行官方安装操作/u);
  assert.match(runningText, /已用时 4 秒/u);
  assert.ok(classesOf(running).includes('pdrop_barFill indeterminate'), 'an unreportable phase animates instead of inventing a percentage');
  assert.ok(classesOf(running).includes('pdrop_bar'), 'the bar is present');

  const reading = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [
    null, null, null,
    { phase: 'reading', label: '读取拖入的文件', ratio: 0.5, detail: '512 KB / 1.0 MB', startedAt: Date.now() },
  ]);
  const readingText = textOf(reading).join('\n');
  assert.match(readingText, /50%/u);
  assert.match(readingText, /512 KB \/ 1\.0 MB/u);
  assert.equal(classesOf(reading).includes('pdrop_barFill indeterminate'), false, 'a measurable phase shows a real percentage');
});

check('a host failure is explained in the reader’s language, raw text kept', () => {
  const DICT = dictionaries.pluginDrop.zh;
  assert.match(DICT.explainToken, /已暂存的插件包/u);
  assert.match(DICT.explainNoProfile, /重启 DSH/u);
  assert.match(DICT.explainNotAPackage, /package\.json/u);
  assert.match(DICT.stagedHostOld, /重启 DSH/u);
  assert.equal(DICT.retriedByPath.length > 10, true);
});

check('the standalone page parses and carries the same three affordances', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'page.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'one inline script');
  // Parsing without executing: a syntax error here would break the page.
  Function(scripts[0]);
  assert.match(html, /id="bar-panel"/u, 'the progress bar exists');
  assert.match(html, /id="staged"/u, 'the staged list exists');
  assert.match(html, /staged\/delete/u, 'the staged delete route is wired');
  assert.match(html, /no longer available/u, 'the token fallback is wired');
});

check('the page explains itself when the host half reports a problem', () => {
  const main = registered.find(entry => entry.options.name === 'main');
  const tree = renderComponent(main.component, { t: ctx.locale.bind('pluginDrop') }, [
    null,
    'the installer only answers requests from this machine',
    { environment: 'DSH_HOME=unset', publishedContext: 'absent' },
  ]);
  const text = textOf(tree).join('\n');
  assert.match(text, /这个安装器无法工作/u);
  assert.match(text, /only answers requests from this machine/u);
  assert.match(text, /environment: DSH_HOME=unset/u, 'the diagnosis is shown for reporting');
  assert.ok(!classesOf(tree).includes('pdrop_zone'), 'no drop surface is offered');
});

check('copy states the restart requirement and the upload escape hatch', () => {
  const DICT = dictionaries.pluginDrop.zh;
  assert.match(DICT.doneBody, /重启 DSH/u);
  assert.match(DICT.tooLarge(80), /64 MiB/u);
  assert.match(DICT.tooLarge(80), /绝对路径/u);
  assert.equal(DICT.confirmRemove('x'), '从当前 profile 卸载 x？');
  assert.equal(DICT.fileCount(7), '7 个');
});

console.log(`\n${passed} checks passed`);
