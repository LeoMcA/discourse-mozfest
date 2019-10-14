const axios = require('axios')
const fs = require('fs').promises

const POST_GENERATOR_VERSION = 6
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
      await catch_and_retry_request({
        method: "put",
        url: `t/${event.topic_id}/reset-bump-date`
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

    for (const event of diff.duplicates) {
      console.log(`Marking ${event.id} duplicate of ${event.duplicate_of} (${event.title})`)
      db[event.id] = { duplicate_of: event.duplicate_of }
      await save_db(db)
    }

  } catch (error) {
    console.error(error)
  }
}

async function get_events () {
  const entries = await zenkit.post("lists/2RH604FcHf/entries/filter/list", { limit: 1000 })
  if (!entries) throw "entries is empty"

  console.log(entries.data.countData.total)
  console.log(entries.data.listEntries.length)

  const events = []

  entries.data.listEntries.forEach(e => {
    let id = e["shortId"]
    let updated_at = new Date(e["updated_at"])
    let authors = [
      e["c4df21bc-c38b-432d-abb7-ad469f8dba9e_references_sort"][0],
      e["4dd2b920-7880-4805-a6eb-4f29b982bd45_references_sort"][0],
      e["1d950611-43a7-456e-b0c7-e6b237ace3bc_references_sort"][0],
      e["43e1d79f-ac07-4f15-9261-032a4ccb2f93_references_sort"][0],
      e["33ff83a1-fe5b-4fcc-8ce3-445355283734_references_sort"][0],
    ].filter(x => x).map(x => x["displayString"])
    let title = e["48420d56-1332-4366-8e2a-bcce7b33d179_text"]
    if (title.trim() === "") {
      console.log(`${id} has no title, not posting`)
      return
    }
    let track = e["ed0250e6-6282-4922-9716-dfd7a29aafb7_categories_sort"][0]
    if (track) {
      track = track["name"]
    } else {
      console.log(`"${title}" doesn't have a track, not posting`)
      return
    }
    let hash = {
      id: id,
      updated_at: updated_at,
      title: title,
      authors: authors,
      description: e["a200e6e4-370d-440c-89af-abf264bf14a6_text"],
      goals: e["be956667-e2ed-4761-b08e-016800e104da_text"],
      track: track
    }

    events.push(hash)
  })

  console.log(`${events.length} events`)

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
    duplicates: []
  }
  const titles = {}

  if (process.env.DELETE_ALL === "true") {
    if (!db) return
    for (k in db) {
      const val = db[k]
      val.id = k
      diff.delete.push(val)
    }
    return diff
  }

  events.forEach(e => {
    const id = e.id
    if (!db[id]) db[id] = {}
    const val = db[id]
    val.run_at = now
    val.updated_at = new Date(val.updated_at)

    const standard_title = e.title.toLowerCase().trim()
    const duplicate = titles[standard_title]
    if (duplicate) {
      e.duplicate_of = duplicate
      return diff.duplicates.push(e)
    } else {
      titles[standard_title] = e.id
    }

    if (val && val.topic_id) {
      if (val.updated_at.valueOf() != e.updated_at.valueOf() || val.gen != POST_GENERATOR_VERSION) {
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
    if (val.run_at != now && !val.duplicate_of) {
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
    if (e.response) {
      switch (e.response.status) {
        case 429:
          var retry_after = parseInt(e.response.headers["retry-after"], 10)
          if (!retry_after) retry_after = n
          console.error(`ERROR: 429 backing off for ${retry_after} seconds`)
          await new Promise(r => setTimeout(r, retry_after * 1000))
          return await catch_and_retry_request(req, n + 1)
        case 422:
          if (e.response.data.errors.includes("Title is too short (minimum is 10 characters)")) {
            console.error("ERROR title is too short, making longer")
            req.data.title = req.data.title + "- Mozilla Festival 2019 Session"
            return await catch_and_retry_request(req, n)
          }
        default:
          console.error(`ERROR: unrecoverable, request:`)
          console.error(req)
          console.error(e.response.status)
          console.error(e.response.data)
          throw "FAILED"
      }
    } else {
      console.error(`ERROR: unrecoverable, request:`)
      console.error(req)
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
  return [hash.track.replace(/&/g, "and")]
}

function generate_post (hash) {
  return `*This session is facilitated by ${hash.authors.join(", ")}*

### About this session
${hash.description.replace("\n", "\n\n")}

### Goals of this session
${hash.goals.replace("\n", "\n\n")}`
}

main()
