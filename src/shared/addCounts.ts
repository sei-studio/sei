/**
 * Library add counts ("added by N players") on World cards and the profile
 * header (261110).
 *
 * Hidden for now (product call 261110: there are not many players yet, so a
 * small number reads as empty). This one constant turns the display back on:
 * the AddCount component renders nothing while it is false, and the
 * profile's own count read (chars:overview-info) is skipped. The World list
 * still fetches counts per page: the popular sort, the merge of the bundled
 * companions into it and the `world_page_loaded` counts props use them.
 */
export const SHOW_ADD_COUNTS = false;
