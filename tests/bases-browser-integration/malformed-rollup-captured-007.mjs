// Offline test input from actual browser007 checkpoint; not a product input.
// Raw report SHA-256: 4fac737ef889b338891be7ec4080ad278dca99dfc1e520b62a18ea27e73bd600.
// The offline manifest uses explicit markers for non-actor revisions;
// runtime expectations independently read all fourteen actual metadata witnesses.
export const captured007 = {
  "result": {
    "rows": [],
    "metadataComplete": false,
    "relationshipsAvailable": true,
    "metadataIssues": [
      {
        "witness": {
          "entryId": "5755fff2-89fd-4ed7-abbc-9d3cab6d0660",
          "revision": "430e394f-da59-477f-be65-3cbc804ce819"
        },
        "exclusion": null,
        "diagnostics": [
          {
            "code": "frontmatter_syntax",
            "severity": "error",
            "range": {
              "bytes": [
                0,
                18
              ],
              "utf16": [
                0,
                18
              ]
            }
          }
        ],
        "propertiesUnavailable": true
      },
      {
        "witness": {
          "entryId": "c3d978d6-d255-4f71-b2fc-8033c39aaeea",
          "revision": "8fb34424-fa1b-46ec-8b7d-9309c2041374"
        },
        "exclusion": "binary",
        "diagnostics": [],
        "propertiesUnavailable": false
      }
    ],
    "diagnostics": [
      {
        "phase": "filter",
        "entryId": "c2f36ad0-b7fc-4519-8074-fab63a18547b",
        "path": "Authors/Ada.md",
        "property": null,
        "code": "type",
        "message": "Cannot convert Error to number"
      },
      {
        "phase": "filter",
        "entryId": "6cc85d01-469a-4e71-89a3-0e5d9732e186",
        "path": "Authors/Grace.md",
        "property": null,
        "code": "type",
        "message": "Cannot convert Error to number"
      },
      {
        "phase": "property",
        "entryId": "467f7476-fb93-4d36-924e-40e315699727",
        "path": "2026-01-02.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "467f7476-fb93-4d36-924e-40e315699727",
        "path": "2026-01-02.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "33754069-647e-47ff-a350-680c6e9ac687",
        "path": "Authors.base",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "33754069-647e-47ff-a350-680c6e9ac687",
        "path": "Authors.base",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c2f36ad0-b7fc-4519-8074-fab63a18547b",
        "path": "Authors/Ada.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c2f36ad0-b7fc-4519-8074-fab63a18547b",
        "path": "Authors/Ada.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "6cc85d01-469a-4e71-89a3-0e5d9732e186",
        "path": "Authors/Grace.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "6cc85d01-469a-4e71-89a3-0e5d9732e186",
        "path": "Authors/Grace.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "903cb508-5a27-4df5-b14a-859856432671",
        "path": "Books.base",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "903cb508-5a27-4df5-b14a-859856432671",
        "path": "Books.base",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "56042a7a-f910-448c-b95f-def513e2a35c",
        "path": "Books/Compiler.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "56042a7a-f910-448c-b95f-def513e2a35c",
        "path": "Books/Compiler.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "2679a157-abe3-4dc5-b2d9-edabcd42719c",
        "path": "Books/Foundations.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "2679a157-abe3-4dc5-b2d9-edabcd42719c",
        "path": "Books/Foundations.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c3a888bb-1c8d-4103-b87c-714f601df92f",
        "path": "Books/Pioneer.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c3a888bb-1c8d-4103-b87c-714f601df92f",
        "path": "Books/Pioneer.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "13139b04-21eb-4e8c-b99e-1cb27dbea379",
        "path": "Inline host.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "13139b04-21eb-4e8c-b99e-1cb27dbea379",
        "path": "Inline host.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "5755fff2-89fd-4ed7-abbc-9d3cab6d0660",
        "path": "Invalid.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "5755fff2-89fd-4ed7-abbc-9d3cab6d0660",
        "path": "Invalid.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "e4f60498-d693-4640-9fbf-ea0a5edd8c68",
        "path": "Not a book.md",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "e4f60498-d693-4640-9fbf-ea0a5edd8c68",
        "path": "Not a book.md",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "2cfd24b7-9dd2-4505-b84c-5960797dbdff",
        "path": "Properties.yaml",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "2cfd24b7-9dd2-4505-b84c-5960797dbdff",
        "path": "Properties.yaml",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "87c1786b-431d-494f-a4df-8cebc572bb58",
        "path": "Rich.base",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "87c1786b-431d-494f-a4df-8cebc572bb58",
        "path": "Rich.base",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c3d978d6-d255-4f71-b2fc-8033c39aaeea",
        "path": "covers/diagram.png",
        "property": "note.averageRating",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      },
      {
        "phase": "property",
        "entryId": "c3d978d6-d255-4f71-b2fc-8033c39aaeea",
        "path": "covers/diagram.png",
        "property": "note.bookCount",
        "code": "unavailable",
        "message": "Rollup relation has invalid or unresolved targets"
      }
    ]
  },
  "authors": [
    {
      "path": "Authors/Ada.md",
      "witness": {
        "entryId": "c2f36ad0-b7fc-4519-8074-fab63a18547b",
        "revision": "ce1966a3-3cbf-4dc8-919f-264d0d7783a6"
      }
    },
    {
      "path": "Authors/Grace.md",
      "witness": {
        "entryId": "6cc85d01-469a-4e71-89a3-0e5d9732e186",
        "revision": "8ec330a4-68e8-4258-9c09-e30d9e698f61"
      }
    }
  ],
  "malformed": {
    "path": "Invalid.md",
    "witness": {
      "entryId": "5755fff2-89fd-4ed7-abbc-9d3cab6d0660",
      "revision": "430e394f-da59-477f-be65-3cbc804ce819"
    }
  },
  "manifest": [
    {
      "path": "2026-01-02.md",
      "witness": {
        "entryId": "467f7476-fb93-4d36-924e-40e315699727",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Authors.base",
      "witness": {
        "entryId": "33754069-647e-47ff-a350-680c6e9ac687",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Authors/Ada.md",
      "witness": {
        "entryId": "c2f36ad0-b7fc-4519-8074-fab63a18547b",
        "revision": "ce1966a3-3cbf-4dc8-919f-264d0d7783a6"
      }
    },
    {
      "path": "Authors/Grace.md",
      "witness": {
        "entryId": "6cc85d01-469a-4e71-89a3-0e5d9732e186",
        "revision": "8ec330a4-68e8-4258-9c09-e30d9e698f61"
      }
    },
    {
      "path": "Books.base",
      "witness": {
        "entryId": "903cb508-5a27-4df5-b14a-859856432671",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Books/Compiler.md",
      "witness": {
        "entryId": "56042a7a-f910-448c-b95f-def513e2a35c",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Books/Foundations.md",
      "witness": {
        "entryId": "2679a157-abe3-4dc5-b2d9-edabcd42719c",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Books/Pioneer.md",
      "witness": {
        "entryId": "c3a888bb-1c8d-4103-b87c-714f601df92f",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Inline host.md",
      "witness": {
        "entryId": "13139b04-21eb-4e8c-b99e-1cb27dbea379",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Invalid.md",
      "witness": {
        "entryId": "5755fff2-89fd-4ed7-abbc-9d3cab6d0660",
        "revision": "430e394f-da59-477f-be65-3cbc804ce819"
      }
    },
    {
      "path": "Not a book.md",
      "witness": {
        "entryId": "e4f60498-d693-4640-9fbf-ea0a5edd8c68",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Properties.yaml",
      "witness": {
        "entryId": "2cfd24b7-9dd2-4505-b84c-5960797dbdff",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "Rich.base",
      "witness": {
        "entryId": "87c1786b-431d-494f-a4df-8cebc572bb58",
        "revision": "offline-capture-revision"
      }
    },
    {
      "path": "covers/diagram.png",
      "witness": {
        "entryId": "c3d978d6-d255-4f71-b2fc-8033c39aaeea",
        "revision": "offline-capture-revision"
      }
    }
  ]
};
