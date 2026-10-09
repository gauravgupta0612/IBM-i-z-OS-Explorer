# IBM i & z/OS Explorer

A Visual Studio Code extension that works with **IBM i** (over SSH) and **z/OS** (over z/OSMF) from a single **IBM i & z/OS** icon in the sidebar. For z/OS it covers what Zowe covers; for IBM i, what Code for IBM i covers.

- **z/OS**
  - Work with data sets, PDS/PDSE members and USS files: browse, edit, and save straight back to the host.
  - Submit JCL, follow jobs and read spool output.
  - Run TSO and MVS console commands.
- **IBM i**
  - Work with libraries, source members and IFS files.
  - Compile members, with errors shown in the Problems panel.
  - Run CL commands and SQL (results in a sortable grid with CSV export).
  - View spooled files, active jobs and job logs.
  - Open an SSH (PASE) terminal.

Author: **Gaurav Gupta** · License: MIT

---

## 1. Install

### From a .vsix file (no source code needed)

1. Download `ibmi-zos-explorer-<version>.vsix` from the [Releases](https://github.com/gauravgupta0612/IBM-i-z-OS-Explorer/releases) page, or get it from the person who shared it.
2. In VS Code: **Extensions** (`Ctrl+Shift+X`) → **`…`** (top right) → **Install from VSIX…** → pick the file.
   From a terminal you can instead run: `code --install-extension ibmi-zos-explorer-<version>.vsix`
3. Reload VS Code if it asks. The **IBM i & z/OS** icon appears in the activity bar.

### From source

See [Development](#6-development) below.

---

## 2. What you need before connecting

### IBM i

| Item | Value / where to get it |
|---|---|
| **Host** | IP address or DNS name of the IBM i, e.g. `myibmi.company.com` |
| **Port** | `22` (SSH). Ask your administrator if they changed it. |
| **User** | Your IBM i user profile, e.g. `GGUPTA` |
| **Password** | Your IBM i password. It is asked on first connect and stored in the Windows Credential Manager / macOS Keychain, never in a file. |
| **SSH key** *(optional)* | Only if your administrator set up key-based login. Choose the key **file** in the wizard. |

**What must be running on the IBM i:**

| Requirement | How to check / enable |
|---|---|
| SSH server | `STRTCPSVR SERVER(*SSHD)`. To start it automatically: `CHGTCPSVR SVRSPCVAL(*SSHD) AUTOSTART(*YES)` |
| IBM i release | 7.3 or later recommended. The extension uses the QSYS2 SQL services: OBJECT_STATISTICS, SYSPARTITIONSTAT, ACTIVE_JOB_INFO, OUTPUT_QUEUE_ENTRIES_BASIC, JOBLOG_INFO. |
| Writable temp directory | `/tmp` by default (setting `mainframe.ibmi.tempDir`), used when transferring source members. |
| *(optional)* `db2util` | `yum install db2util` makes SQL faster. Without it, Qshell `db2` is used. |

To test from a Windows terminal: `ssh YOURUSER@yourhost`. If you get a shell prompt, the extension will connect too.

### z/OS

| Item | Value / where to get it |
|---|---|
| **Host** | The z/OSMF host name, e.g. `mvs.company.com` |
| **Port** | The z/OSMF HTTPS port: often `443`, `10443` or `8443`. Ask your z/OS system programmer. |
| **User** | Your TSO/RACF user ID, e.g. `IBMUSER` |
| **Password** | Your RACF password or passphrase. Stored in the OS keychain. |
| **Protocol** | HTTPS, almost always |
| **Certificate** | Choose **Accept self-signed certificate** if z/OSMF uses an internal or self-signed certificate. |

**What must be running on z/OS:**

| Requirement | Notes |
|---|---|
| z/OSMF | With the REST files, REST jobs, TSO/E address space and console services enabled |
| RACF access | Your user needs access to the z/OSMF `IZUDFLT` profiles (IZUUSER group) |
| TSO account *(for TSO commands)* | Set `mainframe.zos.tsoAccount` to your account number and `mainframe.zos.tsoProc` to your logon procedure |

To test, open `https://<host>:<port>/zosmf/info` in a browser. It should return JSON.

---

## 3. Create a connection

1. Click the **IBM i & z/OS** icon in the activity bar.
2. Click **+** on the **IBM i** or **z/OS** view.
3. Answer the prompts: name → host → port → user → (z/OS: protocol and certificate · IBM i: **Password** or **SSH key file**).
4. Enter your password when asked.
5. Click the plug icon (**Test Connection**). You should see a message such as *"Connected to IBM i 7.5 …"* or *"Connected to z/OS 03.01.00 …"*.

| Problem | Fix |
|---|---|
| `Authentication failed` / `All configured authentication methods failed` | Right-click the connection → **Reset Stored Password** |
| `ENOENT … open '…\Microsoft VS Code\<something>'` | A key file name was entered by mistake. Right-click → **Edit Connection** → choose **Password**. |
| `ECONNREFUSED` / timeout | Wrong host or port, the SSH server or z/OSMF is not started, or a firewall or VPN is blocking you |
| `self signed certificate` | **Edit Connection** → **Accept self-signed certificate** |

---

## 4. Features

### z/OS (z/OSMF REST)

- **Data Sets**: add filters (`USER.**`, `SYS1.PROCLIB`, `HLQ.*.COBOL`), expand PDS/PDSE to see members, open → edit → **Ctrl+S** saves to the mainframe. If someone else changed the member in the meantime, you are warned (ETag check).
  Also: allocate PDS/PDSE/PS (with presets), create and delete members and data sets, recall migrated data sets, upload local files.
- **USS**: browse, open, edit, save, create files and folders, delete, upload.
- **Jobs**: owner/prefix filters, colour-coded status (CC 0000, ABEND, JCL ERROR…), open spool files one by one or all at once, cancel, purge.
- **Submit JCL**:
  - from the editor with `Ctrl+Alt+S` or the ▶ button, with an option to wait and show the output;
  - from a member: right-click → **Submit as Job**.
- **TSO** and **MVS console** commands, with history.
- Syntax highlighting for **JCL** and **COBOL**.

### IBM i (SSH + SQL)

- **Libraries**: add library filters from a list of all libraries. Each library shows its source files (members underneath) and all objects.
- **Source members**: open → edit → **Ctrl+S** saves to the member. Create source files and members, delete members.
- **Compile**: `Ctrl+E` or the ⚙ button. You can review and edit the command before it runs. With `OPTION(*EVENTF)`, compile errors show in the **Problems** panel at the right line. Commands per source type are configurable.
- **Run CL**: from the command palette or a right-click on the connection, with history. The output appears in **Output → IBM i & z/OS**.
- **Run SQL**: from a prompt, or from any `.sql` editor with `Ctrl+R` (runs the statement under the cursor or the selection). Results open in a sortable, filterable grid with **Export CSV**.
- **IFS**: browse, open, edit, save, create, delete.
- **My Spooled Files**: open, delete.
- **My Active Jobs**: open the job log, end the job.
- **PASE shell**: an interactive SSH terminal inside VS Code.
- Syntax highlighting for **RPGLE** (free and fixed format) and **CL**.

---

## 5. Settings

Open **File → Preferences → Settings** and search for `mainframe`.

| Setting | Default | Purpose |
|---|---|---|
| `mainframe.zos.maxItems` | `500` | Maximum data sets/jobs per list |
| `mainframe.zos.encoding` | *(empty)* | EBCDIC code page for data sets, e.g. `IBM-1047`, `IBM-037`, `IBM-297` |
| `mainframe.zos.tsoAccount` | `ACCT#` | TSO account number |
| `mainframe.zos.tsoProc` | `IKJACCNT` | TSO logon procedure |
| `mainframe.ibmi.tempDir` | `/tmp` | IFS temp folder for member transfer |
| `mainframe.ibmi.sourceCcsid` | `1208` | Stream-file CCSID for member transfer (1208 = UTF-8) |
| `mainframe.ibmi.compileCommands` | *(per type)* | Compile command per source type. Variables: `&LIB &FILE &MBR &OBJLIB` |

Per connection: right-click → **Edit Connection** to set the **object library** where compiled objects are created.

**Security:**

- Passwords are kept only in VS Code SecretStorage (the OS keychain).
- Connection profiles (host, port, user, filters) are kept in VS Code's own storage, not in your project.
- Every command sent to the host is logged in **Output → IBM i & z/OS**. Passwords are never logged.

**Known limitation:** IBM i members are transferred with `CPYTOSTMF`/`CPYFRMSTMF`, so sequence numbers and line dates are reset when you save.

---

## 6. Development

Requirements: **Node.js 18+**, **VS Code 1.85+**, **Git**.

```bash
git clone https://github.com/gauravgupta0612/IBM-i-z-OS-Explorer.git
cd IBM-i-z-OS-Explorer
npm install
```

### Run and debug

- **Windows, one click:** double-click `start-debug.bat` and choose 1 (run), 2 (debug) or 3 (build .vsix).
- **Manually:**
  1. Open the folder in VS Code.
  2. Open **Run and Debug**, pick **Run Extension (F5)** and press **F5**.
  3. A second window titled **[Extension Development Host]** opens with the extension loaded. Breakpoints in `src/*.ts` work.
- **Watch mode:** pick **Run Extension (watch mode)**. The code rebuilds when you save; press `Ctrl+R` in the second window to reload.

### Build a .vsix

```bash
npm run package        # → ibmi-zos-explorer-<version>.vsix
```

Raise `"version"` in `package.json` before sharing a new build.

### Project layout

```
src/
  extension.ts        activation, views, status bar
  commands.ts         every command (z/OS + IBM i)
  profiles.ts         connection profiles + password storage + wizard
  sessions.ts         one live client per connection
  fsProvider.ts       "mf:" file system (open/save remote files), read-only spool documents
  zos/zosmf.ts        z/OSMF REST client (data sets, USS, jobs, TSO, console)
  ibmi/ibmiClient.ts  SSH/SFTP client (CL, SQL, members, IFS, spool, jobs)
  ui/trees.ts         sidebar trees
  ui/sqlView.ts       SQL result grid
  ui/terminal.ts      PASE SSH terminal
syntaxes/             JCL, CL, RPGLE, COBOL grammars
```

See [CHANGELOG.md](CHANGELOG.md) for the version history.
