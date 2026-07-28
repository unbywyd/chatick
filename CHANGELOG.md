# Changelog

All notable changes to Chatick are listed here, newest first.

The version at the top must always match `version` in `package.json` — the build
refuses to run otherwise, so a release can never ship without a description.

Written in English only: this file is published on the website.

## 0.2.9 — 2026-07-28

### Fixed

- The tray panel showed "no timer running" while the clock was ticking, and
  pressing play there did nothing visible. The panel only ever heard about a
  timer when something changed in the app window — and a timer that was already
  running is, by definition, nothing changing. Opening the panel now asks the
  app for fresh data instead of replaying whatever it heard last.
- The tray panel could not be dragged while the cursor was over the text next
  to the timer — that area had been excluded from the drag handle along with
  the button.

### Changed

- The tray header says one thing instead of two: with no timer running it now
  shows which project the time would go to, rather than repeating what the
  button already makes obvious.

## 0.2.8 — 2026-07-28

### Added

- Master connection: one tunnel for every project you belong to, across all
  your companies — including ones you join later. The app is built around
  several projects, and a tunnel tied to one of them meant reconnecting on
  every switch. It grants nothing extra: each call still checks your membership
  and permissions in that particular project.
- Assistants can now manage the team from your editor: list who is there, add
  someone, change their role, permissions, job title or area of
  responsibility. A company admin can invite a person from outside in a single
  call — the invite carries the project with it. Removing someone stays in the
  interface: it is irreversible.
- `GET /x/companies` for assistants — your companies with the projects you are
  in, and your role in each. Companies with the same name are flagged, so an
  assistant never picks one by name alone.

### Fixed

- The tray timer went its own way: stopping the clock on the website left it
  ticking in the tray, and starting one there did nothing visible. The panel
  had its own copy of the state that nothing refreshed. Timer changes now reach
  you wherever you are, immediately.
- Play and stop in the tray failed silently. They used the token of whichever
  project was open last, so with none open — or a different one — the request
  died unnoticed. Errors are now shown instead of swallowed.
- The tray lost the project list when you switched projects, and showed "no
  notes yet" on the Projects tab.
- The tray opened empty after launch — only closing and reopening it helped.
- Connecting an assistant to a company crashed the connect screen, which also
  froze the tray: everything the panel does goes through the app window.
- Project names are now unique within a company, case-insensitively. Two
  projects with the same name made "do it in Redesign" meaningless — most of
  all for an assistant picking the project by name from a conversation.
- A malformed request body no longer looks like a server crash.

### Changed

- Any member of a company can connect an assistant to the whole company. It
  used to be limited to admins and managers, leaving everyone else with a
  tunnel to a single project.
- The company picker tells your own companies apart from those you were
  invited to, shows how many projects are in each, and no longer claims you
  have one company when you have several.

## 0.2.7 — 2026-07-28

### Security

- Removing someone from a project now takes their access away immediately.
  Project tokens live for 30 days, and chat and the activity feed trusted the
  token instead of checking membership — so a removed person kept reading and
  writing in the team chat until the token expired. Everything else was already
  safe. Roles are re-read from the database too, so a demoted admin no longer
  keeps admin rights until their token is reissued.

### Added

- Team management from your editor, through the AI bridge: list the team, add
  someone, change their role, permissions, job title, or area of
  responsibility — without opening the interface. A company admin can invite a
  person from outside in a single call: the invite carries the project with it,
  so accepting it joins both.
- A member's role in a project can now be changed. Previously it was set once,
  when they were added — making someone an admin meant removing and re-adding
  them, losing their job title and history. Permissions reset to the new role's
  defaults, so a demotion actually takes access away.

### Changed

- Any member of a company can now connect an assistant to the whole company.
  It used to be limited to admins and managers, which left everyone else with a
  tunnel to a single project — awkward in an app built around several. The
  tunnel opens only the projects you are actually in, with your own permissions,
  so this grants nothing you did not already have. Connecting to one project is
  still available, tucked away for when you deliberately want a narrower scope.
- Notes follow the same rule as tasks and documents: your own note is yours to
  edit and delete, someone else's is read-only.

### Fixed

- A malformed request body returned 500, as if the server had crashed. It now
  returns 400, and the logs are no longer flooded with false alarms.

## 0.2.6 — 2026-07-28

### Fixed

- Granting access from the web failed with "you are not a member of this
  project" even for members: the internal prefix that tells a company apart
  from a project was sent to the server along with the id.

### Changed

- The connect panel in the tray reads better: the selected row is actually
  visible, Allow carries more weight than Cancel, and an empty list no longer
  leaves a hole in the middle of the panel.

## 0.2.5 — 2026-07-28

### Fixed

- "About" showed 0.1.0 no matter which version was running: it read the version
  of the API package, which nobody ever bumps, instead of the product version
  that the build checks against the changelog.

### Changed

- The desktop app now looks for updates every hour instead of every six, and
  "Reload" in the tray asks the server for a new version too — that is what
  someone pressing it expects, not just a page refresh.

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
