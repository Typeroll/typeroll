---
title: Site Fields Tools
description: Give the client settings pages for the values a site shows everywhere, such as opening hours, a booking toggle or a delivery time.
---

These tools wrap `/api/v1/sites/{siteId}/site-fields`.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

Site fields are settings pages for the client, like options pages in
WordPress. A builder defines them once: a checkbox "Show the booking
calendar", a textarea "Visiting address", a number "Delivery days right now",
a dropdown, a list or the week's opening hours. The client then fills in the
values on those pages, without editing pages or the design. In the portal they
are under **Site fields** in the site's navigation.

Values are shared by the whole site. Templates and block text read them as
`{{site.fields.name}}`, the `core/site_field` block shows one value, and the
`core/show_if` block shows or hides blocks by a field.

Site fields are saved directly, without a working copy. Every save keeps the
previous document as a revision. A change reaches the live site with the next
publication. Site fields belong to a version, so a branch can change them
without affecting main.

## The model

```json
{
  "groups": [
    {
      "id": "booking",
      "label": "Booking",
      "description": "What visitors can book right now.",
      "access": "editor",
      "fields": [
        {
          "name": "show_booking",
          "type": "boolean",
          "label": "Show the booking calendar"
        },
        {
          "name": "delivery_days",
          "type": "number",
          "label": "Delivery days right now",
          "min": 0
        }
      ]
    },
    {
      "id": "company",
      "label": "Company details",
      "access": "admin",
      "fields": [
        {
          "name": "visiting_address",
          "type": "textarea",
          "label": "Visiting address",
          "required": true
        }
      ]
    }
  ],
  "values": { "show_booking": true, "delivery_days": 3 },
  "updated_at": "2026-11-07T10:00:00.000Z"
}
```

A **group** is one settings page: `id` (lowercase letters, digits, `-` and
`_`), `label`, an optional `description` and `fields`. A site has at most 20
groups with 200 fields in all.

`access` decides who changes the values:

| `access`           | Values can be changed by                                 |
| ------------------ | -------------------------------------------------------- |
| `editor` (default) | Anyone who may edit content on the site (write or admin) |
| `admin`            | Site administrators only                                 |

The definitions themselves are always changed by site administrators.

**Fields** use the same model as content type fields: `name`, `type`, `label`
and optionally `required`, `help`, `placeholder` and `default`. Names are
lowercase with underscores and unique across the whole site, since templates
read them as `site.fields.name`. The types are `text`, `textarea`,
`richtext`, `boolean` (a checkbox), `number` (`min`, `max`), `select` and
`multiselect` (`options`), `date` (`2026-11-07`), `datetime`, `image`, `url`,
`email`, `page_ref`, `array` (a list with `fields`, `item_label`,
`min_items`, `max_items`) and `object` (a group of fields). Lists and groups
nest at most three levels.

### Live fields

A top-level field with `live: true` is also published as a live file the
moment its value is saved on main, so the `core/site_field` block shows the
newest value without a publication, for example the current delivery time or
today's opening hours. Other fields wait for the next publication. A live
field can be any type, but not a list inside a list; opening hours qualify. See [live snippets](../snippets/) for where the file is
served and what a site needs for it.

### Opening hours

An opening hours field is an `object` field with
`presentation: "opening_hours"` and this shape: a week of seven days plus
dated exceptions such as holidays. The portal shows it as an opening hours
editor.

```json
{
  "name": "opening_hours",
  "label": "Opening hours",
  "type": "object",
  "presentation": "opening_hours",
  "fields": [
    {
      "name": "days",
      "label": "Week",
      "type": "array",
      "min_items": 7,
      "max_items": 7,
      "item_label": "day",
      "fields": [
        {
          "name": "day",
          "label": "Day",
          "type": "select",
          "options": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday"
          ]
        },
        { "name": "closed", "label": "Closed", "type": "boolean" },
        { "name": "opens", "label": "Opens", "type": "text" },
        { "name": "closes", "label": "Closes", "type": "text" }
      ]
    },
    {
      "name": "exceptions",
      "label": "Exceptions",
      "type": "array",
      "max_items": 60,
      "item_label": "date",
      "fields": [
        { "name": "date", "label": "Date", "type": "date", "required": true },
        { "name": "closed", "label": "Closed", "type": "boolean" },
        { "name": "opens", "label": "Opens", "type": "text" },
        { "name": "closes", "label": "Closes", "type": "text" },
        { "name": "note", "label": "Note", "type": "text" }
      ]
    }
  ]
}
```

Its value lists each day with `opens` and `closes` (`09:00`) or
`closed: true`. An exception for a date wins over its weekday:

```json
{
  "days": [
    { "day": "monday", "opens": "09:00", "closes": "17:00" },
    { "day": "sunday", "closed": true }
  ],
  "exceptions": [
    { "date": "2026-12-24", "closed": true, "note": "Christmas Eve" }
  ]
}
```

## Showing values on the site

- **Templates and block text:** `{{site.fields.visiting_address}}`, and
  `{{#each site.fields.staff}}…{{/each}}` for a list.
- **The `core/site_field` block** shows one value inline with a format:
  `text`, `date`, `number`, `list`, `opening_hours_today`,
  `opening_hours_week`, `next_opening` or `open_now`.
- **The `core/show_if` block** shows its blocks only when its condition holds,
  for example `site.fields.show_booking` around a booking calendar.

```json
{
  "type": "core/show_if",
  "data": { "condition": "site.fields.show_booking" },
  "children": [{ "type": "core/embed", "data": { "url": "https://…" } }]
}
```

## `read_site_fields`

Reads the groups, the values, `updated_at` and `editable_groups`: the groups
whose values you may change with your permission. Keep `updated_at`; a save
sends it back as `expected_updated_at`.

## `define_site_fields`

Replaces all groups and their field definitions. Needs admin permission on the
site. Send every group, including the ones you keep: a group or field left out
is removed, and so is its value. Renaming a field is a removal plus an
addition. A value that no longer fits a changed field is dropped too; the
answer lists every dropped value in `dropped_values`.

```
"Give the client a page to switch the booking calendar on and off."
  → read_site_fields
  → define_site_fields expected_updated_at="2026-11-07T10:00:00.000Z"
      groups=[{id:"booking", label:"Booking",
               fields:[{name:"show_booking", type:"boolean",
                        label:"Show the booking calendar"}]}]
```

Send `expected_updated_at` as the `updated_at` you read, or `""` when it was
`null` (nothing saved yet). A save made in between is refused with 409.

## `update_site_fields`

Changes values: send only the fields to change, by name. Other values are kept,
`null` removes a value, and an object or list value is replaced as a whole.
Values in `admin` groups need admin permission; the rest need write
permission.

```
update_site_fields expected_updated_at="2026-11-07T10:00:00.000Z"
  values={show_booking:false, delivery_days:5}
```

Invalid values are refused before anything is saved, with the path of each
problem:

```json
{
  "error": "The site field values were not saved: they are not valid.",
  "status": 400,
  "errors": [{ "path": "delivery_days", "message": "A number expected" }]
}
```

A required field is checked when you change it. A required field that was
never filled in shows up in the
[launch checklist](../../guides/launch-checklist/#site-fields).

## Over REST

| Call                                       | What it does                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `GET /site-fields`                         | Groups, values, `updated_at` and `editable_groups`.                      |
| `PUT /site-fields`                         | Replaces the definitions: `{ groups, expected_updated_at }`. Site admin. |
| `PATCH /site-fields`                       | Changes values: `{ values, expected_updated_at }`; `null` removes one.   |
| `GET /site-fields/revisions`               | Earlier saves, newest first.                                             |
| `POST /site-fields/revisions/{id}/restore` | Restores a revision's definitions and values. Site admin.                |

Every call accepts `?version=` for a branch. A refused save answers 400 with
`{ error, errors: [{ path, message }] }`, 403 without the permission and 409
when the document changed since `expected_updated_at`.

API keys act with their site permission: a site key or the owning
organization's key is admin, a shared site uses the share's permission.
Extension installations need the `site_fields:read` scope to read and
`site_fields:write` to define fields or change any value.

```bash
curl -X PATCH "https://app.typeroll.com/api/v1/sites/$SITE/site-fields" \
  -H "Authorization: Bearer $TYPEROLL_API_KEY" -H "content-type: application/json" \
  -d '{"values":{"delivery_days":3},"expected_updated_at":"2026-11-07T10:00:00.000Z"}'
```
