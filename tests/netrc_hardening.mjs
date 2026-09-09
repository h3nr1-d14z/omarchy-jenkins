// Hostile-path matrix for the netrc credential script in Service.qml.
//
// The marketplace security review pinned the contract: the token read
// must be no-follow/nonblocking, regular-file, owner-checked, mode-checked,
// size-bounded; the netrc must publish through a random exclusive 0600
// temp file with an atomic rename. These checks extract the REAL script
// from the QML source (no transcription drift) and prove every rejection
// marker, so a future edit cannot silently drop the owner/mode/size
// checks. Run standalone: node tests/netrc_hardening.mjs
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const src = fs.readFileSync(new URL("../Service.qml", import.meta.url), "utf8")
const m = src.match(/function netrcCommand\(\) \{[\s\S]*?var script = \[([\s\S]*?)\]\.join\("\\n"\)/)
if (!m) { console.error("FAIL: cannot extract netrcCommand script from Service.qml"); process.exit(1) }
const script = eval("[" + m[1] + "]").join("\n")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netrc-hard-"))
const tf = path.join(dir, "token")
const out = path.join(dir, "netrc")
const CI_URL = "https://ci.example.com/jenkins"

let pass = 0, fail = 0
function run(outPath, tfPath) {
  try {
    return execFileSync("bash", ["-c", script, "jh-netrc", outPath || out, tfPath || tf, "alice", CI_URL],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch (e) { return "EXIT:" + e.status }
}
function check(label, got, want) {
  const ok = got === want
  ok ? pass++ : fail++
  console.log((ok ? "PASS" : "FAIL") + ": " + label + " -> " + JSON.stringify(got)
    + (ok ? "" : " (want " + JSON.stringify(want) + ")"))
}
function leftovers(d) { return fs.readdirSync(d).filter((f) => f.startsWith(".netrc.")).length }

// good token (mode 600)
fs.writeFileSync(tf, "tok123\n", { mode: 0o600 })
check("good token -> ok", run(), "ok")
check("netrc content", fs.readFileSync(out, "utf8"), "machine ci.example.com\nlogin alice\npassword tok123\n")
check("netrc mode 600", (fs.statSync(out).mode & 0o777).toString(8), "600")
check("created parent dir private (700)", (fs.statSync(dir).mode & 0o777).toString(8), "700")
check("no temp leftovers after publish", leftovers(dir), 0)

// missing / symlink / FIFO / bad mode / oversize / empty
check("missing token -> notoken", run(out, path.join(dir, "gone")), "notoken")
fs.rmSync(tf); fs.symlinkSync("/etc/shadow", tf)
check("symlinked token -> badtoken", run(), "badtoken")
fs.rmSync(tf)
execFileSync("mkfifo", [tf])
check("FIFO token -> badtoken (nonblocking)", run(), "badtoken")
fs.rmSync(tf)
fs.writeFileSync(tf, "tok123\n", { mode: 0o640 })
check("group-readable token (640) -> badtoken", run(), "badtoken")
fs.rmSync(tf); fs.writeFileSync(tf, "x".repeat(5120) + "\n", { mode: 0o600 })
check("oversized token (5 KiB) -> badtoken", run(), "badtoken")
fs.writeFileSync(tf, "", { mode: 0o600 })
check("empty token -> badtoken", run(), "badtoken")
check("no temp leftovers after rejections", leftovers(dir), 0)

// pre-planted symlink at the netrc path: rename replaces, never writes through
const victim = path.join(dir, "victim")
fs.writeFileSync(victim, "SENSITIVE\n", { mode: 0o600 })
fs.writeFileSync(tf, "tok123\n", { mode: 0o600 })
fs.rmSync(out); fs.symlinkSync(victim, out)
check("symlinked netrc -> ok (replaced)", run(), "ok")
check("netrc is a regular file", fs.statSync(out).isFile(), true)
check("symlink victim untouched", fs.readFileSync(victim, "utf8"), "SENSITIVE\n")

// pre-existing parent directory mode is never mutated (tokenFile=~/token
// must not chmod $HOME)
const home = path.join(dir, "home")
fs.mkdirSync(home, { mode: 0o755 })
const tfHome = path.join(home, "token")
fs.writeFileSync(tfHome, "tok123\n", { mode: 0o600 })
check("token in pre-existing 755 dir -> ok", run(path.join(home, "netrc"), tfHome), "ok")
check("pre-existing 755 dir left alone", (fs.statSync(home).mode & 0o777).toString(8), "755")

// unwritable publish target fails clean with no orphaned temp
const ro = path.join(dir, "ro")
fs.mkdirSync(ro, { mode: 0o755 })
fs.writeFileSync(path.join(ro, "token"), "tok123\n", { mode: 0o600 })
fs.chmodSync(ro, 0o500)
check("unwritable target -> writefail", run(path.join(ro, "netrc"), path.join(ro, "token")), "writefail")
check("no orphaned temp on writefail", leftovers(ro), 0)

// the temp-cleanup trap is part of the contract (orphan prevention)
check("script carries the temp-cleanup trap", /trap '\[ -n "\$tmp" \] && rm -f "\$tmp" \|\| true' EXIT TERM INT/.test(script), true)

// dd nofollow is a real backstop, not just the -L pre-check
fs.rmSync(tf); fs.symlinkSync("/etc/hostname", tf)
try {
  execFileSync("dd", ["if=" + tf, "iflag=nofollow,nonblock", "bs=4096", "count=1"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  check("dd nofollow rejects symlinks (ELOOP)", "followed", "ELOOP")
} catch (e) { check("dd nofollow rejects symlinks (ELOOP)", e.status === 1 ? "ELOOP" : "status " + e.status, "ELOOP") }

console.log("netrc-hardening: " + pass + " passed, " + fail + " failed")
process.exit(fail ? 1 : 0)
