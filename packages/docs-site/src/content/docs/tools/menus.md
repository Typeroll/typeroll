---
title: Menus Tools
description: Keep the site's navigation as menus with locations, page links that follow renames and automatic submenus.
---

These tools wrap `/api/v1/sites/{siteId}/menus`, with `/{menuId}`, `/{menuId}/usage` and `/{menuId}/revisions` beneath it.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

A menu is a named tree of links that the site keeps once and shows in several
places, like menus in WordPress. The header shows the menu in the `primary`
location, the footer the one in `footer`. Page links point at a page by its id,
so a renamed or moved page keeps its place in every menu. In the portal, menus
are under **Menus** in the site's navigation.

Menus are saved directly, without a working copy. Every save keeps the
previous menu as a revision. A change reaches the live site with the next
publication, and the preview shows it at once. Menus belong to a version, so a
branch can change its menus without affecting main.

## The menu model

```json
{
  "id": "primary",
  "name": "Main menu",
  "locations": ["primary"],
  "auto_add_pages": true,
  "items": [
    { "id": "home", "type": "page", "page_id": "home" },
    {
      "id": "services",
      "type": "page",
      "page_id": "services",
      "children": [
        { "id": "service-pages", "type": "children", "page_id": "services" }
      ]
    },
    {
      "id": "shop",
      "type": "url",
      "href": "https://shop.example.com",
      "label": "Shop"
    }
  ],
  "updated_at": "2026-11-07T10:00:00.000Z"
}
```

An item is one of four types:

| Type       | Fields              | What it shows                                                                                                                                                    |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`     | `page_id`, `label`? | A link to the page with its current title and address. `label` overrides the title. An unpublished or deleted page drops out, with a warning in the publication. |
| `url`      | `href`, `label`     | Any other address: an external site, a path or an `#anchor`.                                                                                                     |
| `children` | `page_id`, `label`? | The page's published child pages, in their sort order. With a `label` they form a submenu under it; without one they sit in place among their siblings.          |
| `heading`  | `label`             | A title without a link, for example a column title in a wide submenu.                                                                                            |

Every item has an `id` that is unique in the menu; leave it out on a new item
and one is assigned. An item can also set `description` (a short line under the
label in submenus), `icon` and `link_rel` (for example `nofollow sponsored`).

Items with `children` get a submenu. A menu is at most three levels deep and
holds at most 200 items. A submenu whose items have children of their own is
laid out in columns: a wide menu, with a heading or page per column.

### Locations

`locations` names the places a menu fills: `primary` (the header), `footer`
and `mobile`, or another short lowercase name the site uses. A location shows
one menu. A save that lists a location another menu already fills is refused
with 409 and names that menu, unless it sends `take_locations: true`: then the
location moves to the menu you save. The other menu keeps its items and its
other locations, its change is kept as a revision, and the response lists each
move in `moved_locations: [{ "location": "primary", "from_menu_id": "primary" }]`.
Nothing has to be deleted first. In the portal, **Menus → New menu** and the
menu editor offer locations another menu uses, labelled with that menu's name;
choosing one moves it the same way.

A site can have any number of menus. A menu without a location is shown where a
navigation block names it by id (`menu: "legal"`).

### New pages are added automatically

With `auto_add_pages: true`, new top-level published pages are added to the
end of the menu automatically, as in WordPress. Pages that are already in the
menu, child pages and the home page are not. A new site's `primary` menu has
it turned on, so when the header shows that menu, creating a page puts it in
the header. Turn it off to choose every link yourself.

## A new site's menus

A new site starts with two menus:

- `primary` (location `primary`): the home page, with `auto_add_pages` on.
- `footer` (location `footer`): the home page.

A header or footer shows them once it has a `core/navigation_links` block with
`source: "menu"`; see [showing a menu](#showing-a-menu-in-the-header-or-footer).
An older HTML header keeps the links written into it.

You can edit these two menus, or build your own beside them. To give the header
your own menu, create it with the location and `take_locations: true`:

```
update_menu name="Huvudmeny" locations=["primary"] take_locations=true
  items=[{type:"page",page_id:"home"},{type:"page",page_id:"meny"}]
```

The new menu fills `primary` at once; the starter `primary` menu keeps its
items without a location, so a header that shows `location:primary` shows your
menu. Delete the starter menu later if you do not need it. Note that the starter
menu has `auto_add_pages` on: turn it on in your own menu if new pages should
still appear in the header.

## `list_menus`

Lists every menu of the site (or of a `version`) with its locations, items and
`updated_at`.

## `read_menu`

Reads one menu by `menu_id`. Keep its `updated_at`: an update sends it back as
`expected_updated_at`.

## `update_menu`

Creates a menu or replaces a whole menu: `name`, `locations`,
`auto_add_pages` and the full `items` tree. To change an existing menu, read
it, change the tree and send it back with `expected_updated_at`. If someone
saved the menu in between, the save is refused with 409; read it again and
reapply the change. Without `menu_id`, or with one that does not exist yet, a
new menu is created. Add `take_locations: true` to move a listed location from
the menu that fills it (see [locations](#locations)).

```
"Add Services with its subpages to the main menu."
  → read_menu menu_id="primary"
  → update_menu menu_id="primary" name="Main menu" locations=["primary"]
      auto_add_pages=true expected_updated_at="2026-11-07T10:00:00.000Z"
      items=[{id:"home",type:"page",page_id:"home"},
             {id:"services",type:"page",page_id:"services",
              children:[{id:"service-pages",type:"children",page_id:"services"}]}]
```

The whole menu is validated before anything is saved. An invalid menu returns
`errors` with the path of each problem:

```json
{
  "error": "The menu was not saved: it is not valid.",
  "status": 400,
  "errors": [{ "path": "items[1].href", "message": "Give the address" }]
}
```

## `add_menu_item`

Appends one item and saves the menu: at the top level, or under
`parent_item_id` in that item's submenu. `position` inserts it at an index
among its siblings. The tool reads the menu and saves it with its
`updated_at`, so a concurrent save is refused rather than lost. It returns the
saved menu and the new item's `item_id`.

```
add_menu_item menu_id="primary" item={type:"page", page_id:"about"}
add_menu_item menu_id="primary" parent_item_id="services"
  item={type:"url", href:"https://shop.example.com", label:"Shop"}
```

## `delete_menu`

Deletes a menu. A navigation block that shows it, by id or by its location,
renders an empty list until another menu fills the location. Check
`find_menu_usage` first.

## `find_menu_usage`

Lists where a menu is shown: the global blocks (header, footer and others),
pages and page templates whose `core/navigation_links` block has
`source: "menu"` and names the menu by id or by one of its locations, saved or
in a draft. Read it before deleting a menu or moving its location.

## Over REST

| Call                            | What it does                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /menus`                    | Every menu.                                                                                                            |
| `POST /menus`                   | Creates a menu (201). Without `id`, one is derived from the name. `take_locations` moves taken locations.              |
| `GET /menus/{menuId}`           | One menu (404 when unknown).                                                                                           |
| `PUT /menus/{menuId}`           | Replaces the whole menu; send `expected_updated_at` (409 when stale, or a location is taken without `take_locations`). |
| `DELETE /menus/{menuId}`        | Deletes the menu.                                                                                                      |
| `GET /menus/{menuId}/usage`     | Where the menu is shown.                                                                                               |
| `GET /menus/{menuId}/revisions` | Earlier saves; `/{revId}` reads one and `POST /{revId}/restore` restores it.                                           |

Every call accepts `?version=` for a branch.

```bash
curl -X POST "https://app.typeroll.com/api/v1/sites/$SITE/menus" \
  -H "Authorization: Bearer $TYPEROLL_API_KEY" -H "content-type: application/json" \
  -d '{"id":"legal","name":"Legal","locations":["legal"],"items":[{"type":"page","page_id":"privacy"}]}'
```

## Showing a menu in the header or footer

A `core/navigation_links` block shows a menu instead of its own links with
`source: "menu"` and `menu`, a menu id or a location such as
`location:primary`. A location follows whichever menu fills it, so the header
keeps working when you swap menus. This needs render version 15
(`read_site_settings` → `render.version`; raise it with
`tr-upgrade-rendering`).

```json
{
  "type": "core/navigation_links",
  "data": {
    "source": "menu",
    "menu": "location:primary",
    "direction": "row",
    "submenus": "auto"
  }
}
```

`submenus` chooses how submenus open:

| Value       | Submenus                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------- |
| `auto`      | A dropdown in a row of links, an accordion in a column and in the mobile menu. The default. |
| `dropdown`  | A panel under the item that opens on hover, focus or its button.                            |
| `accordion` | The submenu opens in place under the item.                                                  |
| `expanded`  | The child links are always shown, for example in a footer.                                  |
| `none`      | Only the top level is shown.                                                                |

Submenus follow the disclosure navigation pattern: a button with
`aria-expanded` opens each one, Escape closes it, and the current page and its
parent items are marked (`aria-current="page"`). Without JavaScript a dropdown
opens on hover and keyboard focus, and an accordion shows its links. The
dropdown panels, submenu buttons, headings and descriptions are style parts of
the block; see [style parts](../blocks/parts/).

Put the block in the header's `core/navigation_menu` (both the desktop and the
mobile slot can show the same location) and in the footer. A menu that does not
exist renders an empty list. Blocks with their own `links` work as before.
