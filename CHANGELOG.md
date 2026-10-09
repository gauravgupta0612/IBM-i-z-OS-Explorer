# Changelog

## [1.1.0] – 2026-10-09

### Added – z/OS
- **Search text** in a partitioned data set, or in every PDS of a data set filter; results open at the matching line.
- **Copy** a member to another data set (with an overwrite check), **copy all members** of a PDS, **rename** members and data sets.
- **Data set attributes** (organization, record format, space, dates, volume…).
- **Download all members** of a PDS to a local folder, and **upload a local folder** into a PDS.
- **Jobs:** view and edit a job's original JCL, and **resubmit** a job in one click.
- **JCL templates:** generate COBOL compile + link (IGYWCL), compile-link-go (IGYWCLG), assembler (ASMACL) and "run program" JCL for a member. Add your own templates in the settings; the job card, load library and copy library are configurable.

### Added – IBM i
- **Search text** in a source file or in all source files of a library, and in IFS folders.
- **Library list and current library** for CL commands and compiles, managed in the new *Library List* node (add, remove, reorder, set current library).
- **Object actions:** delete, rename, object description (DSPOBJD), program references (DSPPGMREF), file fields (DSPFFD), and query the data of a file (first 1000 rows in the SQL grid).
- **Message queues:** browse QSYSOPR and your own message queue, read message help, and reply to inquiry messages.

### Added – general
- **Favorites:** star members and files for one-click access at the top of each connection.
- **Compare with local file** for any remote member or file.
- **Export and import connections**, without passwords, to share them with colleagues.
- **Snippets** for JCL (job card, IEFBR14, IEBCOPY, IEBGENER, SORT, IDCAMS, IKJEFT01…), COBOL, RPGLE (free format) and CL.

### Fixed
- Commands that need an item from the tree no longer appear in the Command Palette, where they could not work.

## [1.0.0] – 2026-10-09

First release of **IBM i & z/OS Explorer** by Gaurav Gupta.

### z/OS (z/OSMF REST)
- **Data sets:**
  - filters, PDS/PDSE members;
  - open, edit and save back to the host, with a warning if someone else changed the member since you opened it (ETag check);
  - allocate PDS/PDSE/PS from presets, create and delete members and data sets, recall migrated data sets, upload local files.
- **USS:** browse, open, edit, save, create files and directories, delete, upload.
- **Jobs:**
  - owner/prefix filters, colour-coded status and return codes;
  - open spool files one by one or all at once, cancel, purge.
- **Submit JCL** from the editor (`Ctrl+Alt+S`) or from a member, with an option to wait for the job and show its output.
- **TSO** and **MVS console** commands, with history.

### IBM i (SSH + SQL)
- **Libraries:** library filters picked from a list; each library shows its source files, members and objects.
- **Source members:** open, edit and save; create source files and members; delete members.
- **Compile** (`Ctrl+E`): configurable commands per source type; with `OPTION(*EVENTF)`, errors appear in the Problems panel.
- **CL commands** with history.
- **SQL** from a prompt or a `.sql` editor (`Ctrl+R`): results in a sortable, filterable grid with CSV export.
- **IFS:** browse, edit, create, delete.
- **Spooled files**, **active jobs** with job logs, **end job**.
- **PASE shell:** an interactive SSH terminal inside VS Code.
- **Sign-in:** the connection wizard asks **Password** (kept in the OS keychain) or **SSH private key file** (picked with a file dialog).

### General
- Syntax highlighting for JCL, COBOL, RPGLE and CL.
- Every request sent to the host is logged in the *IBM i & z/OS* output channel; passwords are never logged.
- Debug setup:
  - `.vscode/launch.json` and `.vscode/tasks.json`;
  - `start-debug.bat` (Windows, one click);
  - source maps and a rebuild-on-save mode (`npm run watch`).
- GitHub Actions workflow that builds the `.vsix` and publishes a GitHub Release when a `v*` tag is pushed.
