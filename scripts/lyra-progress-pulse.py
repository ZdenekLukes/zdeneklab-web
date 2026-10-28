#!/usr/bin/env python3
"""Public-site-only half-hour heartbeat for LYRA (no private AI_HEAD access)."""
import datetime as dt
import json
import pathlib
import urllib.request

UTC = dt.timezone.utc
now = dt.datetime.now(UTC)
start = dt.datetime(2026, 10, 28, 5, 0, tzinfo=UTC)  # 06:00 Prague
end = dt.datetime(2026, 10, 28, 17, 0, tzinfo=UTC)   # 18:00 Prague
if not start <= now <= end:
    print("LYRA sprint heartbeat outside 12-hour window; no update")
    raise SystemExit(0)

file = pathlib.Path("lyra-progress.json")
data = json.loads(file.read_text(encoding="utf-8"))
if data.get("schema") != 1:
    raise SystemExit("LYRA progress schema mismatch")
iso = now.isoformat(timespec="seconds").replace("+00:00", "Z")
pulse = data.setdefault("pulse", {})
pulse["lastCheckedAt"] = iso
pulse["publicPreview"] = "mechanical-studio-preview-integration-lyra-polish-0700.html"

# GitHub API is used ONLY for the PUBLIC website preview commit; the actual AI_HEAD
# source repo is private and does not become accessible to this scheduled workflow.
url = ("https://api.github.com/repos/ZdenekLukes/zdeneklab-web/commits"
       "?path=mechanical-studio-preview-integration-lyra-polish-0700.html&per_page=1")
try:
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "zdeneklab-lyra-progress/1.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
        commits = json.load(response)
    if isinstance(commits, list) and commits:
        commit = commits[0]
        websha = commit.get("sha", "")
        if websha:
            before = pulse.get("lastPublicPreviewCommit")
            pulse["lastPublicPreviewCommit"] = websha
            pulse["lastPublicPreviewAt"] = commit.get("commit", {}).get("committer", {}).get("date")
            if before and before != websha:
                history = data.setdefault("history", [])
                if not any(e.get("previewSha") == websha for e in history):
                    history.insert(0, {
                        "at": iso,
                        "title": "NOVÝ WEB PREVIEW",
                        "detail": "Publikována nová verze Mechanical Studio; samo o sobě to není PRINT RELEASE.",
                        "previewSha": websha})
except Exception as exc:
    # Failed public GitHub API lookup must never overwrite verified engineering status.
    pulse["previewLookupError"] = str(exc)[:140]
else:
    pulse.pop("previewLookupError", None)

file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("Pulse checked", iso, "data last verified", data.get("updatedAt"),
      "web preview", pulse.get("lastPublicPreviewCommit", "unavailable"))
