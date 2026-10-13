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
import { properties } from "../properties";

/** Core views installed on vault open (in ribbon order). */
export const coreModules: CoreModule[] = [explorer, search, backlinks, outgoingLinks, tags, outline, bookmarks, graph, canvas, bases, properties];
