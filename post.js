const axios = require('axios')
const fs = require('fs').promises

const POST_GENERATOR_VERSION = 4
const MOZFEST_CATEGORY_ID = process.env.CATEGORY_ID

const zenkit = axios.create({
  baseURL: "https://zenkit.com/api/v1/",
  headers: {
    "Zenkit-API-Key": process.env.ZENKIT_KEY,
    "Content-Type": "application/json"
  }
})

const discourse = axios.create({
  baseURL: process.env.DISCOURSE_URL,
  headers: {
    "Api-Key": process.env.DISCOURSE_KEY,
    "Api-User": process.env.DISCOURSE_USER
  }
})

async function main () {
  try {
    const events = await get_events()
    const diff = await generate_diff(events)
    const db = await fetch_db()

    for (const event of diff.post) {
      console.log(`Posting "${event.title}"`)
      const res = await catch_and_retry_request({
        method: "post",
        url: "posts.json",
        data: {
          category: MOZFEST_CATEGORY_ID,
          title: event.title,
          raw: generate_post(event),
          tags: generate_tags(event)
        }
      })
      if (!db[event.id]) db[event.id] = {}
      const value = db[event.id]
      value.topic_id = res.data.topic_id
      value.post_id = res.data.id
      await complete_request(event, value, db)
    }

    for (const event of diff.update) {
      console.log(`Updating "${event.title}, topic: ${event.topic_id}, post: ${event.post_id}"`)
      await catch_and_retry_request({
        method: "put",
        url: `t/-/${event.topic_id}.json`,
        data: {
          title: event.title,
          tags: generate_tags(event)
        }
      })
      await catch_and_retry_request({
        method: "put",
        url: `posts/${event.post_id}.json`,
        data: {
          post: {
            raw: generate_post(event)
          }
        }
      })
      await complete_request(event, db[event.id], db)
    }

    for (const event of diff.delete) {
      console.log(`Deleting ${event.topic_id}`)
      await catch_and_retry_request({
        method: "delete",
        url: `t/${event.topic_id}`
      })
      delete db[event.id]
      await save_db(db)
    }

  } catch (error) {
    console.error(error)
  }
}

async function get_events () {
  const entries = await zenkit.post("lists/2RH604FcHf/entries/filter/list")
  if (!entries) throw "entries is empty"

  const events = []

  entries.data.listEntries.forEach(e => {
    let id = e["shortId"]
    let updated_at = new Date(e["updated_at"])
    let hash = {
      id: id,
      updated_at: updated_at,
      title: e["48420d56-1332-4366-8e2a-bcce7b33d179_text"],
      authors: e["c4df21bc-c38b-432d-abb7-ad469f8dba9e_references_sort"][0]["displayString"],
      description: e["a200e6e4-370d-440c-89af-abf264bf14a6_text"],
      track: e["ed0250e6-6282-4922-9716-dfd7a29aafb7_categories_sort"][0]["name"]
    }

    events.push(hash)
  })

  return events
}

async function fetch_db () {
  const data = await fs.readFile("./db.json", "utf8")
  return data ? JSON.parse(data) : {}
}

async function save_db (db) {
  await fs.writeFile("./db.json", JSON.stringify(db), "utf8")
}

async function generate_diff (events) {
  const now = Date.now()
  const db = await fetch_db()
  const diff = {
    post: [],
    update: [],
    delete: [],
  }

  events.forEach(e => {
    const id = e.id
    if (!db[id]) db[id] = {}
    const val = db[id]
    val.run_at = now
    if (val && val.topic_id) {
      if (val.updated_at != e.updated_at || val.gen != POST_GENERATOR_VERSION) {
        e.topic_id = val.topic_id
        e.post_id = val.post_id
        e.gen = POST_GENERATOR_VERSION
        diff.update.push(e)
      }
    } else {
      diff.post.push(e)
    }
  })

  if (!db) return

  for (k in db) {
    const val = db[k]
    val.id = k
    if (val.run_at != now) {
      diff.delete.push(val)
    }
  }

  return diff
}

async function catch_and_retry_request (req, n) {
  if (!n) n = 0
  try {
    return await discourse(req)
  } catch (e) {
    if (e.response && e.response.status == 429) {
      var retry_after = parseInt(e.response.headers["retry-after"], 10)
      if (!retry_after) retry_after = n
      console.error(`ERROR: 429 backing off for ${retry_after} seconds`)
      await new Promise(r => setTimeout(r, retry_after * 1000))
      return await catch_and_retry_request(req, n + 1)
    } else {
      console.error(`ERROR: unrecoverable, request:`)
      console.error(req)
      if (e.response) {
        console.error(e.response.status)
        console.error(e.response.data)
      }
      throw "FAILED"
    }
  }
}

async function complete_request (event, value, db) {
  value.updated_at = event.updated_at
  value.gen = POST_GENERATOR_VERSION
  await save_db(db)
}

function generate_tags (hash) {
  return [hash.track]
}

function generate_post (hash) {
  return `${hash.authors}

${hash.description.replace("\n", "\n\n")}`
}

main()
