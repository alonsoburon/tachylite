import type { CoreModule } from "./util";
import { explorer } from "./explorer";
import { search } from "./search";
import { backlinks, outgoingLinks } from "./links";
import { tags } from "./tags";
import { outline } from "./outline";
import { bookmarks } from "./bookmarks";
import { graph } from "./graph";
import { canvas } from "./canvas";
import { bases } from "../../bases";
import { templates } from "./templates";
import { dailyNotes } from "./dailyNotes";
import { noteComposer } from "./noteComposer";
import { slashCommands } from "./slashCommands";
import { randomNote } from "./randomNote";
import { wordCount } from "./wordCount";
import { properties } from "../properties";
import { fileRecovery } from "./fileRecovery";
import { workspaces } from "./workspaces";
import { pagePreview } from "./pagePreview";

/** Core views installed on vault open (in ribbon order). */
export const coreModules: CoreModule[] = [explorer, search, backlinks, outgoingLinks, tags, outline, bookmarks, graph, canvas, bases,
  properties, fileRecovery, workspaces, pagePreview, dailyNotes, templates, noteComposer, randomNote, slashCommands, wordCount];
