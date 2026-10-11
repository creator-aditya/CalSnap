# CalSnap

**Share → Extract → Review → Add to Calendar → Reminder**

CalSnap is a small web application that reads event details out of text you paste or
share, lets you review and correct them, and then prepares the event for your
calendar. Everything runs in the browser: no account, no server, no database,
nothing uploaded.

---

## 1. What works in the web application, and what does not

| Capability | Status |
| --- | --- |
| Paste event text and extract title, date, start/end time, location, description | **Works** in every modern browser |
| Review and edit every extracted field | **Works** |
| Validation with clear, specific messages | **Works** |
| Prefilled Google Calendar event page | **Works** (opens a page; the user saves it there) |
| Downloadable `.ics` file with reminder (`VALARM`) | **Works** |
| Native share sheet from the device (Web Share API) | **Works** on Android browsers and iOS Safari; otherwise CalSnap copies the details to the clipboard |
| Receiving a share from another app (the Chrome/Android "Share → CalSnap" entry) | **Works only after the app is installed** as a PWA through the `share_target` manifest entry |
| Reading a shared **link's** page content | **Not possible from the browser** (cross-origin restrictions). CalSnap says so instead of guessing |
| Android share intent / iOS Share Extension (appearing in the system share sheet from any app, without installing the PWA) | **Requires native integration** — the plan is in [section 8](#8-platform-specific-sharing-what-still-needs-native-work) |

CalSnap never claims that an event or a reminder has been saved. Only the calendar
application you send the event to can create it.

---

## 2. File structure

```
CalSnap/
├── index.html            # Application structure: input, review form, reminder, actions
├── style.css             # Responsive mobile-first styling (light + dark)
├── manifest.json         # PWA manifest, including the Android/Chrome share_target
├── sw.js                 # Service worker: offline shell only
├── icon.png              # 512px app icon (also icon-192.png / icon-512.png)
│
├── js/
│   ├── extractor.js      # Step 4  - text -> event details      (no DOM access)
│   ├── validation.js     # Step 5  - details -> errors/warnings (no DOM access)
│   ├── calendar.js       # Steps 6-8 - Google Calendar URL + .ics generation
│   └── ui.js             # Steps 3, 5-10 - DOM wiring only
│
├── tests/                # Node test suites (no dependencies, no browser needed)
│   ├── load-globals.js   # Loads the browser scripts into Node
│   ├── ics-reader.js     # Unfolds/parses a generated .ics the way a calendar app would
│   ├── extractor.test.js
│   ├── validation.test.js
│   ├── calendar.test.js
│   ├── ui.test.js        # Drives js/ui.js against a small DOM stub
│   ├── workflow.test.js  # Share -> extract -> validate -> Google/.ics, end to end
│   ├── browser-smoke.html   # Real-browser fixture: full workflow
│   └── browser-share.html   # Real-browser fixture: share-target input
│
├── tools/
│   ├── serve.js          # Zero-dependency local static server
│   ├── browser-smoke.ps1 # Runs the fixtures through headless Chrome/Edge
│   ├── make-sample.js    # Writes tools/sample-event.ics from the sample event
│   ├── validate-ics.py   # Independent RFC 5545 structural check of an .ics file
│   └── make-icons.py     # Regenerates the PNG icons
│
├── .vscode/              # Press F5: serve + debug configurations (see section 3)
├── package.json          # Scripts only; there are no runtime dependencies
└── README.md
```

**Why this split:** `extractor.js`, `validation.js` and `calendar.js` never touch the
DOM, so the same logic can be reused by an Android share intent or an iOS Share
Extension ([section 8](#8-platform-specific-sharing-what-still-needs-native-work)) and
can be unit-tested in Node. `ui.js` contains all the DOM code and no business rules.

---

## 3. Running it locally

Requirements: [Node.js](https://nodejs.org) 18 or newer. There are no dependencies to
install.

```bash
# from the CalSnap folder
npm start
# -> CalSnap is available at http://127.0.0.1:5173/
```

Or with the Node executable directly:

```bash
node tools/serve.js          # port 5173
node tools/serve.js 9000     # a different port
```

Use a server rather than opening `index.html` from disk: `file://` disables the
service worker and the share target.

### Running and debugging it in Visual Studio Code

Open the folder (**File → Open Folder… → `CalSnap`**), then press **F5**. The
`.vscode` folder already contains everything needed:

| Configuration (F5 → pick one) | What it does |
| --- | --- |
| **CalSnap: serve + open Chrome** | Starts the static server, opens `http://127.0.0.1:5173/` in Chrome, and maps the page back to this folder so breakpoints in `js/*.js` hit |
| **CalSnap: serve + open Edge** | The same, with Microsoft Edge |
| **CalSnap: open a simulated shared link** | Opens `index.html?text=…&url=…`, exactly what the Android share target sends — a plain refresh cannot reproduce this |
| **Tests: debug the open test file** | Runs the test file you have focused under the debugger |
| **Tests: all suites (no debugger)** | Runs the end-to-end workflow suite |

Useful details:

* Set a breakpoint in `js/extractor.js` (for example inside `extract`) and extract some
  text; the debugger stops there with the full call stack, so you can inspect how each
  field was found.
* **Ctrl+Shift+B** is not needed — there is nothing to build, which is why the
  configurations only start a server and attach.
* The server task also appears under **Terminal → Run Task** (`serve: CalSnap`,
  `test: CalSnap (all suites)`, `sample: write and validate an .ics file`).
* Pressing F5 again reuses the running server instead of failing with "port in use", and
  a second Chrome window is fine — the app keeps no state between loads.
* Only one extension is *suggested* (`ms-vscode.live-server`); nothing is required,
  because VS Code's built-in JavaScript debugger runs this project as it is.

The `.vscode` folder is committed on purpose: the launch configurations are part of how
this project is meant to be run.

### If you prefer Visual Studio 2022

Visual Studio (the full IDE) is not the natural tool for a static, build-free
JavaScript project, and it is not installed on this machine. It can still be used:

1. Install the **Node.js development** workload from the Visual Studio Installer.
2. **File → Open → Folder…** and choose the `CalSnap` folder (there is no `.sln`, and
   one is not needed).
3. Open **View → Terminal** and run `npm start`, then open
   `http://127.0.0.1:5173/` in a browser.
4. To debug, open `js/extractor.js`, set a breakpoint, and use
   **Debug → Attach to Process** → pick the Chrome/Edge process, or run
   **Debug → Start Debugging** on a test file such as `tests/workflow.test.js`
   (Node.js project support is what the workload adds).

In practice, VS Code gives the better experience here: attach-to-browser debugging,
the `.vscode` configurations above, and no solution file to maintain.

### Trying the three output paths

1. Paste event text such as:

   ```text
   Annual Design Summit 2026
   Saturday, 14 March 2026
   Time: 9:30 AM - 4:00 PM
   Location: Riverside Convention Centre, Hall B
   Join 300 designers for a day of talks and workshops.
   ```

2. Choose **Extract Event Details**.
3. Check the review form, correct anything, pick a reminder.
4. Choose **Open Google Calendar** (a prefilled page opens), **Download .ics file**
   (import it into Google Calendar, Apple Calendar, Outlook, …), or **Share event details**.

To test the share path without a phone, open the share-target URL directly:

```
http://127.0.0.1:5173/index.html?text=Design%20Summit%0A2026-05-01%20at%2010:00%0ALocation:%20Hall%20B
```

---

## 4. Running the tests

```bash
npm test                 # all five suites (92 checks)
npm run test:extractor   # event extraction from text
npm run test:validation  # validation rules
npm run test:calendar    # Google Calendar URL + .ics generation (with reminder)
npm run test:ui          # interface wiring against a DOM stub
npm run test:workflow    # the whole Share -> Extract -> Review -> Calendar flow
```

The suites are plain Node files (`node --test`), with no test framework to install.
`node tests/extractor.test.js` also works on its own, which is useful inside
sandboxes that block the multi-process test runner.

To inspect a real generated file by hand, and check it against the RFC 5545 rules
with a checker that does not reuse the generator's own code:

```bash
npm run sample            # writes tools/sample-event.ics and prints the Google link
npm run sample:validate   # ...and validates it (132 structural conditions)
```

What is covered, mapped to the requirements:

| Requirement | Test |
| --- | --- |
| Titles extracted | `extractor.test.js` → *title: …* |
| Dates interpreted correctly (ISO, numeric, day-first, month names, "tomorrow", weekdays) | `extractor.test.js` → *date: …* |
| Start/end times populated when available | `extractor.test.js` → *time: …* |
| Locations extracted when available | `extractor.test.js` → *location: …* |
| Descriptions retained | `extractor.test.js` → *description: …* |
| Extracted fields editable | `ui.test.js` → *extracted fields stay editable* |
| Invalid/incomplete details handled | `validation.test.js`, `ui.test.js` → *missing details block …* |
| Google Calendar URL contains the right information | `calendar.test.js` → *google: …* |
| `.ics` files contain the right event details | `calendar.test.js` → *ics: …* (read back with `tests/ics-reader.js`) |
| Reminder included in the `.ics` file | `calendar.test.js` → *ics: each reminder option …* |
| Browser sharing | `ui.test.js` → *sharing uses the web share sheet / falls back to the clipboard* |
| Mobile and desktop interface | `ui.test.js` asset checks + responsive CSS; verify visually as in section 6 |
| No false claim that something was saved | `workflow.test.js` → *nothing in the pipeline claims an event was already saved* |

Every `.ics` assertion above reads the generated file back through
`tests/ics-reader.js` (unfolding continuation lines and unescaping values), so a file
that passes is one a calendar application can actually parse. `tools/validate-ics.py`
adds an independent check of the same rules, written from the RFC rather than from the
generator, for the cases where both sides could share the same misunderstanding.

---

## 5. Deploying for free

The application is static files, so any free static host works. Two options:

### Option A — GitHub Pages

```bash
cd CalSnap
git init
git add .
git commit -m "CalSnap"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

Then, on GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main`,
folder: `/ (root)` → Save**. The app appears at
`https://<your-user>.github.io/<your-repo>/` after a minute or two.

All paths in the project are relative, so it works from a sub-path like that one.

### Option B — Netlify or Cloudflare Pages

* Netlify: drag the whole CalSnap folder onto <https://app.netlify.com/drop>, or
  connect the Git repository with **build command** empty and **publish directory** `.`.
* Cloudflare Pages: connect the repository, leave the build command empty and set the
  output directory to `/`.

Both give a public HTTPS URL, which is required for the service worker, the share
target and the Web Share API.

### Deployment checklist

- [ ] Open the public URL on a phone and a desktop browser.
- [ ] Paste text, extract, and check every field is editable.
- [ ] Generate a Google Calendar link and confirm the event appears prefilled.
- [ ] Download the `.ics` file and import it into a calendar application.
- [ ] Confirm the imported event kept the reminder (some applications drop it).
- [ ] On Android Chrome or iOS Safari, use **Share event details**.
- [ ] On Android Chrome, install the app (⋮ → *Add to Home screen*) and check that
      CalSnap now appears as a share target.

---

## 6. Verifying the responsive interface by hand

There is also an automated browser check that drives the real DOM in headless Chrome
or Edge (start the app first):

```bash
npm start
# in a second terminal:
powershell -NoProfile -File tools/browser-smoke.ps1
```

It prints JSON for four scenarios: the full paste → extract → Google link → `.ics`
flow, a share with text and a link, a share with a link only (which must not invent
details), and a messy real-world message. Sample output:

```text
===== share target: messy real-world text =====
"title":    "Winter Party"
"date":     "2026-12-18"
"start":    "19:00"
"location": "The Old Mill, Riverside"
```

For the layout itself, the interface is mobile-first and adapts at 560 px and 900 px:

1. Open the deployed URL in a desktop browser.
2. Open the developer tools and switch on the device toolbar.
3. Check at **360 × 640** (small phone), **390 × 844** (iPhone), **768 × 1024**
   (tablet) and **1440 × 900** (desktop):
   - the text area and every field stay usable and are not cut off;
   - the action buttons stack on phones and sit in a row from 560 px up;
   - error and notice messages wrap instead of overflowing;
   - the page is usable in both light and dark mode (`prefers-color-scheme`).

---

## 7. How extraction behaves (and its limits)

`js/extractor.js` finds the first plausible value for each field. It recognises:

* **Dates** — `2026-03-15`, `05/01/2026`, `15/03/2026`, `April 22, 2026`, `22nd April`,
  `12 May 2026`, `today`, `tonight`, `tomorrow`, `in 3 days`, `next week`, `next month`,
  and bare weekdays (the next occurrence).
* **Times** — `14:30`, `2:30pm`, `2 PM`, `noon`, `midnight`, and ranges such as
  `9:30 AM - 4:00 PM`, `14:00 to 16:00` and `2 to 4 PM`.
* **Location** — a `Location:`/`Where:`/`Venue:`/`Address:` line, or an `at`/`in`/`@`
  phrase; it stops before the next time, date or labelled field.
* **Title** — an `Event:`/`Title:`/`Subject:` label, otherwise the first line that is
  not a greeting, a label, a link or a bare date; a link-only share falls back to the
  URL slug.

Deliberate limitations:

* An unknown **end time** stays empty. The form says the event will be created one hour
  long, and the `.ics` file records that assumption in an `X-CALSNAP-NOTE` field.
* Ambiguous numeric dates (`03/04/2026`) are read as **month/day**.
* A **link only** cannot be read: browsers block cross-origin page fetches, and CalSnap
  has no backend. It explains this instead of inventing details.
* Two different dates or times in one text (an agenda, say) produce the first pair.
* Before creating a calendar file, the description is the text you supplied, with a
  leading date/time line left in place. Trim it in the Description field if you do not
  want it in the calendar entry.

---

## 8. Platform-specific sharing: what still needs native work

The web application already does what a website can do:

* **`manifest.json` → `share_target`** registers CalSnap as a share target for
  **Android Chrome / Chromium browsers once the PWA is installed**. The browser then
  opens `index.html?title=…&text=…&url=…`, and `js/ui.js` reads those parameters,
  fills the text area and runs the extraction automatically.
* **`navigator.share`** is used for outgoing shares where the browser supports it, with
  a clipboard fallback elsewhere.

Not included in this web version, because each needs a native build:

| Platform | What it needs | Where the shared logic plugs in |
| --- | --- | --- |
| **Android** | A thin wrapper app (Trusted Web Activity / Capacitor / WebView) with an `ACTION_SEND` intent filter for `text/plain`. The intent handler reads `Intent.EXTRA_TEXT` / `EXTRA_SUBJECT` and passes them to the existing page as query parameters, exactly like `share_target` does. | Reuse `Extractor.extract()`, `Validation.validate()` and `CalendarCore` unchanged; only the entry point differs. |
| **iOS / iPadOS** | A Share Extension target in an Xcode project (or a Shortcut that opens `https://…/index.html?text=…`). The extension reads the shared text/URL from its `NSExtensionItem` and forwards it the same way. | Same modules; the extension only has to hand over text. |
| **Desktop browsers** | Already supported: pasting text, opening the prefilled Google Calendar page, downloading the `.ics` file, and `navigator.share` on browsers that implement it. | — |

Because the extraction, validation and calendar code contain no DOM access, a native
shell only has to deliver text — no logic needs to be rewritten.

---

## 9. Known limitations

* Reminders inside an `.ics` file are a request, not a guarantee: some calendar
  applications ignore imported `VALARM` entries. Google Calendar cannot receive a
  reminder through a prefilled URL at all, so the interface says so next to the button.
* Extraction is a set of documented heuristics, not a language model. Unusual phrasings
  may need a manual correction — which is exactly what the review step is for.
* CalSnap has no backend, so shared links are never fetched.

## 10. Licence

MIT.
