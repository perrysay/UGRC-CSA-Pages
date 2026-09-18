"""Stage only the DM page and its dependencies for a focused Jekyll preview."""
from pathlib import Path
import shutil

pages = Path(__file__).resolve().parents[1]
stage = pages / ".dm-preview/source"

# The stage is reused between runs. A layout left over from a previous run under
# a name the page no longer asks for is invisible until something renders wrong,
# so clear the directory rather than copying over it.
shutil.rmtree(stage / "_layouts", ignore_errors=True)


def copy(source, destination):
    target = stage / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pages / source, target)


copy("_projects/systems/direct-messages/index.md", "messages.md")
# Named for the layout the page actually asks for. Jekyll silently renders an
# unwrapped page when the layout is missing, which looks like broken CSS rather
# than a missing file, so keep this in step with index.md's front matter.
copy("scripts/dm-preview-layout.html", "_layouts/opencs.html")
copy("assets/js/api/config.js", "assets/js/api/config.js")

# The conversation panel is the site's shared chat component, so the preview
# needs its script and stylesheet too, not just the DM-specific files.
copy("assets/js/chat/rich-text.js", "assets/js/chat/rich-text.js")
for source in (pages / "assets/js/projects/direct-messages").glob("*.js"):
    copy(source.relative_to(pages), source.relative_to(pages))

copy("assets/css/projects/direct-messages/main.scss", "assets/css/projects/direct-messages/main.scss")
copy("_sass/projects/direct-messages/main.scss", "_sass/projects/direct-messages/main.scss")

# SCSS partials the DM stylesheet imports. Jekyll resolves these from the
# staged tree's own _sass directory, so they have to be staged as well.
for partial in (
    "_sass/root-color-map.scss",
    "_sass/user-colors.scss",  # imported by root-color-map
    "_sass/open-coding/chat-ui.scss",
    "_sass/open-coding/mixins/_buttons.scss",
):
    copy(partial, partial)

print("Preview source: 1 page (Messages), its JavaScript, SCSS, and a minimal local layout.")
