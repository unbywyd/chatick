# Changelog

All notable changes to Chatick are listed here, newest first.

The version at the top must always match `version` in `package.json` — the build
refuses to run otherwise, so a release can never ship without a description.

Written in English only: this file is published on the website.

## 0.2.4 — 2026-07-28

### Changed

- Choosing where to grant an assistant access now separates companies from
  projects instead of mixing them into one flat list. Granting a company opens
  every project inside it, including ones created later — that is a different
  decision from granting a single project, and the list now says so.
- The search box is always there rather than appearing once the list grows past
  a threshold: a field that comes and goes is harder to rely on than one that
  is simply always present.

## 0.2.3 — 2026-07-28

### Fixed

- The tray panel only ever offered projects from your first company, so an
  assistant could not be connected to a project in a company you had been
  invited to — those projects were simply missing from the list.

### Changed

- Choosing where to grant an assistant access is now searchable, in the tray and
  on the web alike. With a dozen projects across two companies the list ran past
  the bottom of the panel and the Allow button had to be hunted for by scrolling.
  Projects are labelled with their company, since the same project name in two
  companies is not unusual.
- Granting access to a whole company is now possible on the web too; it had only
  ever been available in the tray.

## 0.2.2 — 2026-07-28

### Fixed

- The tray panel was empty in the installed application, while it worked when
  run from source: `panel.html` and its preload script were simply missing from
  the package. The list of packaged files was written out by hand, and these two
  were forgotten. It now uses patterns instead of a hand-kept list.

## 0.2.1 — 2026-07-28

### Fixed

- The tray panel opened empty. Its state was sent while the window was still
  loading, so it arrived nowhere, and the panel then waited for the next update
  from the app — which can be a minute away.
- The desktop app stopped feeding the tray when it had been opened before
  signing in: it checked for a session once at startup and never again.

## 0.2.0 — 2026-07-28

### Added

- A Windows installer, with the shell updating itself in the background and
  applying the update on exit. The interface already updates on every launch,
  since it is loaded from the web.
- Keyboard shortcuts for everyday actions — create a task, document or resource,
  jump to files, tasks or the time tracker, move focus between chat and AI.
  Press `?` anywhere for the cheat sheet, or remap them on the shortcuts page.
- System notifications on the desktop and on the web, with a single place to
  decide whether they appear at all, whether they make a sound, and whether they
  stay quiet while the app is already in front of you.
- A notifications page that keeps the full history. Until now a notification
  disappeared for good once it was read.
- Sharing for files, documents, notes, resources and single messages — either a
  private link for people who already have access, or a public read-only link
  that works without signing in and can be revoked at any time.
- A preview page for shared files: images, video, audio and PDF play in place
  instead of forcing a download.
- "About" with a feedback form, reachable from the profile menu and the tray.

### Changed

- Notifications arrive the moment they happen instead of up to thirty seconds
  later, and now reach you anywhere in the app rather than only inside the
  project they came from.
- Durations are typed the way a clock reads them: `2:30` and `230` both mean two
  and a half hours, `45` means forty-five minutes.
- Files, documents, notes and resources show a handle when you hover them, so
  it is clear they can be dragged into the chat.
- Originals of optimised images are no longer stored, which leaves far more of
  a project's storage for actual work.

### Fixed

- Notifications never appeared in the browser at all, and on Windows they were
  dropped silently by the system.
- Clicking a system notification opened the right place but left the
  notification unread in the bell and the tray.
- The rich text editor showed raw HTML instead of formatted text.
- Filters on the overview were applied but invisible, so a filtered page looked
  like an empty one.

## 0.1.0 — 2026-06-01

### Added

- First working version: chat with an AI dispatcher, tasks, time tracking,
  documents, notes, files and resources in a single workspace.
- Google sign-in, projects, companies and per-project roles.
- Desktop application for Windows and macOS with a tray panel.
