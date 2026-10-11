/**
 * Interface tests - Step 13 items 6, 7, 11 and 13.
 *
 * js/ui.js only touches the DOM through getElementById / addEventListener, so a
 * small stub is enough to drive the real interface code without a browser. This
 * catches wiring mistakes (missing elements, unhandled validation, false claims)
 * that pure logic tests cannot see.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Validation } = require('./load-globals.js');

const ROOT = path.join(__dirname, '..');

// Load the application modules once, exactly as index.html does, so the interface
// resolves the same UrlFetch / Extractor / Validation / CalendarCore objects.
require(path.join(ROOT, 'js', 'urlfetch.js'));
require(path.join(ROOT, 'js', 'extractor.js'));
require(path.join(ROOT, 'js', 'validation.js'));
require(path.join(ROOT, 'js', 'calendar.js'));

/* -------------------------------------------------------------------------- *
 * A deliberately small DOM stub
 * -------------------------------------------------------------------------- */

class StubClassList {
    constructor() { this.set = new Set(); }
    add(...names) { names.forEach((n) => this.set.add(n)); }
    remove(...names) { names.forEach((n) => this.set.delete(n)); }
    contains(name) { return this.set.has(name); }
    toString() { return [...this.set].join(' '); }
}

class StubElement {
    constructor(tag = 'div', id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.value = '';
        this.textContent = '';
        this.className = '';
        this.classList = new StubClassList();
        this.attributes = {};
        this.listeners = {};
        this.focused = 0;
        this.scrollIntoView = () => {};
    }
    addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
    }
    dispatch(type, event = {}) {
        (this.listeners[type] || []).forEach((handler) => handler(Object.assign({ target: this, preventDefault() {} }, event)));
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    focus() { this.focused += 1; }
}

/** Builds a stub DOM that mirrors the ids used by index.html and js/ui.js. */
function createDom(search = '') {
    const ids = [
        'raw-text', 'btn-extract', 'btn-text', 'input-section', 'review-section',
        'extraction-notice', 'extraction-hint', 'event-form', 'event-title', 'event-date',
        'event-start', 'event-end', 'event-location', 'event-desc', 'event-reminder',
        'btn-back', 'btn-google', 'btn-ics', 'btn-share', 'status'
    ];
    const byId = new Map();
    for (const id of ids) {
        const tag = id.startsWith('btn-') || id === 'btn-back' ? 'button' : 'input';
        byId.set(id, new StubElement(tag, id));
    }
    byId.get('event-reminder').value = 'none';
    // index.html labels the button; the stub needs the same starting text so the
    // link-reading path can be checked for restoring it.
    byId.get('btn-text').textContent = 'Extract Event Details';

    const body = new StubElement('body');
    const windowListeners = {};
    const opened = [];
    const downloads = [];
    const copied = [];

    const windowStub = {
        location: { search, protocol: 'https:', href: 'https://example.test/' + search },
        listeners: windowListeners,
        setTimeout: (fn) => { fn(); return 0; },
        open(url) { opened.push(String(url)); return { closed: false }; },
        addEventListener(type, handler) { (windowListeners[type] = windowListeners[type] || []).push(handler); },
        dispatch(type) { (windowListeners[type] || []).forEach((handler) => handler()); },
        URLSearchParams,
        navigator: undefined,
        document: undefined
    };

    const documentStub = {
        getElementById: (id) => byId.get(id) || null,
        createElement: (tag) => {
            const element = new StubElement(tag);
            if (tag === 'a') {
                Object.defineProperty(element, 'click', {
                    value: () => downloads.push({ name: element.download, href: element.href })
                });
            }
            return element;
        },
        body: {
            appendChild() {},
            removeChild() {}
        },
        addEventListener(type, handler) {
            (windowListeners['doc:' + type] = windowListeners['doc:' + type] || []).push(handler);
        }
    };

    const navigatorStub = {
        share: null,
        clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } }
    };

    return {
        document: documentStub,
        window: windowStub,
        navigator: navigatorStub,
        byId,
        opened,
        downloads,
        copied,
        get: (id) => byId.get(id)
    };
}

/** Flushes pending promise callbacks (share / clipboard) without fake timers. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits until `check()` is true, or gives up after ~1s so a failure is explicit. */
async function waitFor(check, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return check();
}

/** Load js/extractor.js + validation.js + calendar.js + ui.js and boot the UI. */
function bootUi(dom) {
    const sources = ['js/urlfetch.js', 'js/extractor.js', 'js/validation.js', 'js/calendar.js', 'js/ui.js']
        .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
        .join('\n;\n');

    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        navigator: globalThis.navigator,
        Blob: globalThis.Blob,
        createObjectURL: globalThis.URL.createObjectURL,
        revokeObjectURL: globalThis.URL.revokeObjectURL
    };

    // Node 24 exposes `navigator` as an accessor-only global, so plain assignment
    // throws; define the stub values instead.
    const define = (name, value) => Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true
    });
    define('window', dom.window);
    define('document', dom.document);
    define('navigator', dom.navigator);
    dom.window.navigator = dom.navigator;
    dom.window.document = dom.document;

    // Captures what would have been downloaded to the user's device.
    const blobParts = [];
    globalThis.Blob = class Blob {
        constructor(parts) { this.parts = parts; blobParts.push(parts.join('')); }
    };
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};

    // These stay in place for the whole test: the stubbed UI resolves some
    // handlers only after a real tick.
    try {
        // eslint-disable-next-line no-new-func
        new Function(sources)();
        dom.window.dispatch('doc:DOMContentLoaded');
        dom.window.dispatch('DOMContentLoaded');
    } catch (error) {
        define('window', previous.window);
        define('document', previous.document);
        define('navigator', previous.navigator);
        globalThis.Blob = previous.Blob;
        globalThis.URL.createObjectURL = previous.createObjectURL;
        globalThis.URL.revokeObjectURL = previous.revokeObjectURL;
        throw error;
    }

    return {
        blobs: blobParts,
        restore() {
            define('window', previous.window);
            define('document', previous.document);
            define('navigator', previous.navigator);
            globalThis.Blob = previous.Blob;
            globalThis.URL.createObjectURL = previous.createObjectURL;
            globalThis.URL.revokeObjectURL = previous.revokeObjectURL;
        }
    };
}

/* -------------------------------------------------------------------------- *
 * Wiring
 * -------------------------------------------------------------------------- */

test('interface: every id used by ui.js exists in index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');

    const used = [...ui.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(used.length > 10, 'expected the interface to look up its elements');

    for (const id of used) {
        assert.ok(html.includes('id="' + id + '"'), 'index.html is missing id="' + id + '"');
    }
});

test('interface: index.html loads the stylesheet that actually exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // Local assets are the hrefs with no scheme and no host (external font hosts
    // are ignored here).
    const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1])
        .filter((href) => !/^(?:[a-z]+:|\/\/)/i.test(href) && !href.includes('/'));

    assert.ok(hrefs.includes('style.css'), 'the stylesheet must be linked with its real name: ' + hrefs.join(', '));
    for (const href of hrefs) {
        assert.ok(fs.existsSync(path.join(ROOT, href)), 'missing local asset: ' + href);
    }
});

test('interface: every local script and manifest asset exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

    for (const src of scripts) {
        assert.ok(fs.existsSync(path.join(ROOT, src)), 'missing script: ' + src);
    }
    // Load order matters: extractor and validation must exist before calendar/ui.
    assert.deepEqual(scripts, ['js/urlfetch.js', 'js/extractor.js', 'js/validation.js', 'js/calendar.js', 'js/ui.js']);

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    for (const icon of manifest.icons) {
        assert.ok(fs.existsSync(path.join(ROOT, icon.src)), 'manifest icon is missing: ' + icon.src);
    }
});

/* -------------------------------------------------------------------------- *
 * Behaviour
 * -------------------------------------------------------------------------- */

test('interface: extracting fills the form and shows the review section', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Annual Design Summit\nDate: March 12, 2026\nTime: 9:30 AM - 4:00 PM\nLocation: Riverside Centre';
        dom.get('btn-extract').dispatch('click');

        assert.equal(dom.get('event-title').value, 'Annual Design Summit');
        assert.equal(dom.get('event-date').value, '2026-03-12');
        assert.equal(dom.get('event-start').value, '09:30');
        assert.equal(dom.get('event-end').value, '16:00');
        assert.equal(dom.get('event-location').value, 'Riverside Centre');
        assert.equal(dom.get('review-section').classList.contains('hidden'), false);
        assert.equal(dom.get('input-section').classList.contains('hidden'), true);
    } finally {
        runtime.restore();
    }
});

test('interface: extracted fields stay editable and the edits are used', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Yoga class tomorrow at 6 PM';
        dom.get('btn-extract').dispatch('click');

        // The user corrects the extraction (Step 5: review and edit).
        dom.get('event-title').value = 'Yoga class (beginner)';
        dom.get('event-date').value = '2026-08-09';
        dom.get('event-start').value = '18:30';

        dom.get('btn-google').dispatch('click');
        assert.equal(dom.opened.length, 1);
        const params = new URL(dom.opened[0]).searchParams;
        assert.equal(params.get('text'), 'Yoga class (beginner)');
        assert.match(params.get('dates'), /^20260809T/);
    } finally {
        runtime.restore();
    }
});

test('interface: missing details block the calendar actions with a clear message', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Team offsite sometime soonish';
        dom.get('btn-extract').dispatch('click');

        // No date and no time were found, so nothing may be generated.
        assert.equal(dom.get('event-date').value, '');
        assert.match(dom.get('extraction-hint').textContent, /could not identify the date and start time/i);

        dom.get('btn-google').dispatch('click');
        dom.get('btn-ics').dispatch('click');

        assert.equal(dom.opened.length, 0, 'Google Calendar must not open without a date');
        assert.equal(dom.downloads.length, 0, 'no .ics may be downloaded without a date');
        assert.match(dom.get('status').textContent, /Choose an event date/i);
        assert.equal(dom.get('status').className.includes('error'), true);
        assert.equal(dom.get('event-date').getAttribute('aria-invalid'), 'true');
        assert.ok(dom.get('event-date').focused > 0, 'the field to fix is focused');
    } finally {
        runtime.restore();
    }
});

test('interface: an end time before the start time is refused with an explanation', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('event-title').value = 'Standup';
        dom.get('event-date').value = '2026-05-01';
        dom.get('event-start').value = '15:30';
        dom.get('event-end').value = '14:00';

        dom.get('btn-google').dispatch('click');

        assert.equal(dom.opened.length, 0);
        assert.match(dom.get('status').textContent, /before the start time/i);
        assert.equal(dom.get('event-end').getAttribute('aria-invalid'), 'true');
    } finally {
        runtime.restore();
    }
});

test('interface: the .ics button downloads a file with the reviewed content', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('event-title').value = 'Design Review';
        dom.get('event-date').value = '2026-05-01';
        dom.get('event-start').value = '15:30';
        dom.get('event-end').value = '17:00';
        dom.get('event-location').value = 'Studio 2';
        dom.get('event-reminder').value = '60';

        dom.get('btn-ics').dispatch('click');

        assert.equal(dom.downloads.length, 1);
        assert.equal(dom.downloads[0].name, 'design-review-2026-05-01.ics');

        const content = runtime.blobs[0];
        assert.match(content, /BEGIN:VCALENDAR/);
        assert.match(content, /SUMMARY:Design Review/);
        assert.match(content, /LOCATION:Studio 2/);
        assert.match(content, /TRIGGER:-PT60M/);
        assert.match(dom.get('status').textContent, /was downloaded/i);
    } finally {
        runtime.restore();
    }
});

test('interface: no download or share message ever claims the event was saved', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Client call tomorrow at 3:30 PM';
        dom.get('btn-extract').dispatch('click');

        dom.get('btn-google').dispatch('click');
        const googleMessage = dom.get('status').textContent;
        assert.match(googleMessage, /Review it there and press Save/i);
        assert.doesNotMatch(googleMessage, /\b(event (was )?(added|saved|created|scheduled)|saved to your calendar)\b/i);

        dom.get('btn-ics').dispatch('click');
        const downloadMessage = dom.get('status').textContent;
        assert.match(downloadMessage, /CalSnap cannot add it for you/i);
        assert.doesNotMatch(downloadMessage, /\b(event (was )?(added|saved|created|scheduled))\b/i);
    } finally {
        runtime.restore();
    }
});

test('interface: the reminder is transferred to .ics but not promised for Google', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Client call tomorrow at 3:30 PM';
        dom.get('btn-extract').dispatch('click');
        dom.get('event-reminder').value = '15';

        dom.get('btn-google').dispatch('click');
        assert.match(dom.get('status').textContent, /is asked to set this reminder/i);

        dom.get('btn-ics').dispatch('click');
        assert.match(runtime.blobs[runtime.blobs.length - 1], /TRIGGER:-PT15M/);
    } finally {
        runtime.restore();
    }
});

test('interface: sharing uses the web share sheet when the device has one', async () => {
    const dom = createDom();
    const calls = [];
    dom.navigator.share = (data) => { calls.push(data); return Promise.resolve(); };

    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Client call tomorrow at 3:30 PM';
        dom.get('btn-extract').dispatch('click');
        dom.get('btn-share').dispatch('click');
        await flush();

        assert.equal(calls.length, 1);
        assert.match(calls[0].text, /Client call/);
        assert.match(dom.get('status').textContent, /share sheet/i);
    } finally {
        runtime.restore();
    }
});

test('interface: sharing falls back to the clipboard when there is no share sheet', async () => {
    const dom = createDom();
    dom.navigator.share = undefined;

    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Client call tomorrow at 3:30 PM';
        dom.get('btn-extract').dispatch('click');
        dom.get('btn-share').dispatch('click');
        await flush();

        assert.equal(dom.copied.length, 1);
        assert.match(dom.copied[0], /Client call/);
        assert.match(dom.get('status').textContent, /copied to the clipboard/i);
    } finally {
        runtime.restore();
    }
});

test('interface: cancelling the share sheet is not reported as an error', async () => {
    const dom = createDom();
    dom.navigator.share = () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));

    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Client call tomorrow at 3:30 PM';
        dom.get('btn-extract').dispatch('click');
        dom.get('btn-share').dispatch('click');
        await flush();

        assert.match(dom.get('status').textContent, /cancelled/i);
        assert.equal(dom.get('status').className.includes('error'), false);
    } finally {
        runtime.restore();
    }
});

test('interface: shared content from the Share menu is prefilled and extracted', () => {
    const sharedText = encodeURIComponent('Design Summit\nDate: 2026-05-01 at 10:00\nLocation: Hall B');
    const dom = createDom('?text=' + sharedText + '&url=https%3A%2F%2Fexample.com%2Fsummit');

    const runtime = bootUi(dom);
    try {
        assert.match(dom.get('raw-text').value, /Design Summit/);
        assert.match(dom.get('raw-text').value, /https:\/\/example\.com\/summit/);
        // A share launch arrives straight in the review step.
        assert.equal(dom.get('review-section').classList.contains('hidden'), false);
        assert.equal(dom.get('event-title').value, 'Design Summit');
        assert.equal(dom.get('event-date').value, '2026-05-01');
    } finally {
        runtime.restore();
    }
});

test('interface: a link-only input starts reading the page, inventing nothing', () => {
    const dom = createDom('?url=' + encodeURIComponent('https://example.com/events/spring-product-launch'));
    const runtime = bootUi(dom);
    try {
        // The page is fetched, not guessed at: the interface says so, and no date or
        // time appears from the link itself.
        assert.match(dom.get('extraction-notice').textContent, /Fetching|Reading the page/i);
        assert.equal(dom.get('event-date').value, '', 'no date may be invented from a link');
        assert.equal(dom.get('event-start').value, '', 'no time may be invented from a link');
    } finally {
        runtime.restore();
    }
});

test('interface: a link-only input reads the page and fills the form from it', async () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    // The stub is installed after bootUi: booting re-runs js/urlfetch.js, which
    // replaces globalThis.UrlFetch with a fresh object.
    const realLoad = globalThis.UrlFetch.load;
    globalThis.UrlFetch.load = () => Promise.resolve({
        ok: true,
        route: 'direct',
        page: {
            title: 'Sharon Verma Live',
            startDate: '2026-11-14T19:30:00+05:30',
            endDate: '2026-11-14T21:00:00+05:30',
            location: 'The Comedy Club, Mumbai',
            description: 'A brand new hour of stand up.',
            text: 'Sharon Verma Live\nThe Comedy Club, Mumbai',
            source: 'json-ld'
        }
    });

    try {
        dom.get('raw-text').value = 'https://in.bookmyshow.com/events/sharon-verma-live/ET00521481';
        dom.get('btn-extract').dispatch('click');
        await waitFor(() => dom.get('event-date').value !== '');

        // The link produced the same filled form as pasted text would.
        assert.equal(dom.get('event-title').value, 'Sharon Verma Live');
        assert.equal(dom.get('event-date').value, '2026-11-14');
        assert.equal(dom.get('event-start').value, '19:30');
        assert.equal(dom.get('event-end').value, '21:00');
        assert.equal(dom.get('event-location').value, 'The Comedy Club, Mumbai');
        assert.equal(dom.get('review-section').classList.contains('hidden'), false);
        assert.match(dom.get('extraction-notice').textContent, /read from the page/i);
        assert.match(dom.get('extraction-notice').textContent, /your browser/i);
        assert.equal(dom.get('extraction-hint').textContent, '', 'a complete page leaves nothing to ask for');
    } finally {
        globalThis.UrlFetch.load = realLoad;
        runtime.restore();
    }
});

test('interface: a link whose page cannot be read says so plainly', async () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    const realLoad = globalThis.UrlFetch.load;
    globalThis.UrlFetch.load = () => Promise.resolve({
        ok: false,
        route: '',
        reason: 'The page could not be read: the site blocks requests from a browser that is not showing the page, ' +
            'and CalSnap has no server to fetch it for you.'
    });

    try {
        dom.get('raw-text').value = 'https://in.bookmyshow.com/events/sharon-verma-live/ET00521481';
        dom.get('btn-extract').dispatch('click');
        await waitFor(() => /could not be read/i.test(dom.get('extraction-notice').textContent));

        const notice = dom.get('extraction-notice');
        assert.match(notice.textContent, /could not be read/i);
        assert.match(notice.textContent, /blocks requests/i);
        assert.equal(notice.className.includes('warning'), true, 'a warning, not an error');
        assert.equal(dom.get('event-date').value, '', 'no date may be invented from a link');
        assert.equal(dom.get('btn-text').textContent, 'Extract Event Details', 'the button returns to normal');
    } finally {
        globalThis.UrlFetch.load = realLoad;
        runtime.restore();
    }
});

test('interface: a link in otherwise usable text is noted, not treated as a failure', () => {
    const dom = createDom();
    const runtime = bootUi(dom);
    try {
        dom.get('raw-text').value = 'Design Summit\nDate: 2026-05-01 at 10:00\nLocation: Hall B\nhttps://example.com/summit';
        dom.get('btn-extract').dispatch('click');

        assert.equal(dom.get('event-date').value, '2026-05-01');
        assert.equal(dom.get('event-location').value, 'Hall B');
        assert.equal(dom.get('extraction-notice').className.includes('error'), false);
    } finally {
        runtime.restore();
    }
});

test('interface: validation rules used by the form match the shared module', () => {
    // Guards against the form drifting away from js/validation.js.
    const result = Validation.validate({ title: '', date: 'nope', startTime: '99:99', endTime: '', reminder: 'none' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.field), ['title', 'date', 'startTime']);
});
