const axios = require('axios')
const fs = require('fs')

const POST_GENERATOR_VERSION = 6
const MOZFEST_CATEGORY_ID = 5

const zenkit = axios.create({
  baseURL: "https://zenkit.com/api/v1/",
  headers: {
    "Zenkit-API-Key": process.env.ZENKIT_KEY,
    "Content-Type": "application/json"
  }
})

const discourse = axios.create({
  baseURL: "http://localhost:3000/",
  headers: {
    "Api-Key": process.env.DISCOURSE_KEY,
    "Api-User": "system"
  }
})

async function main() {
  try {
    const workspaces = await zenkit.get("users/me/workspacesWithLists")
    const workspace = workspaces.data.find(x => x.name == "Mozilla Festival 2019")
    if (!workspace) throw "2019 workspace doesn't exist"

    const lists = workspace.lists
    // console.log(lists)
    const entries = await zenkit.post(`lists/${lists[0].shortId}/entries/filter/list`)
    // const entries = { data: { listEntries: [] } }
    // const entries = await zenkit.post(`lists/2RH604FcHf/entries/filter/list`)
    // console.log(entries.data)

    fs.readFile("./db.json", "utf8", (err, data) => {
      const now = Date.now()
      const db = data ? JSON.parse(data) : {}

      const promises = []
      entries.data.listEntries.forEach(e => {
        let status = e["cd94d644-663d-484b-8dcc-1c764a24822c_categories_sort"][0]["name"]
        if (status != "Accepted") return

        let id = e["shortId"]
        let html = e["f1d85268-8b9a-49da-9487-3ee7ecac4e74_text"]
        let hash = {
          id: id,
          updated_at: new Date(e["updated_at"]),
          title: e["d1188949-7559-423f-abeb-abd0158e8fe5_text"],
          authors: /<em>(.*)<\/em>/.exec(html)[0],
          description: e["922c3ec7-6b95-4e4e-9345-f10fec6a9a89_text"],
          track: lists[0].name,
          discourse_topic_id: undefined,
          run_at: now,
          post_generator_version: POST_GENERATOR_VERSION
        }

        let db_value = db[id]
        if (db_value && db_value.discourse_topic_id) {
          db[id].run_at = now
          if (db_value.updated_at < hash.updated_at || db_value.post_generator_version != POST_GENERATOR_VERSION) {
            console.log(`Updating "${hash.title}, topic: ${db_value.discourse_topic_id}"`)
            hash.discourse_topic_id = db_value.discourse_topic_id
            hash.post_generator_version = POST_GENERATOR_VERSION
            promises.push(post_to_discourse(hash).then(hash => {
              db[id] = hash
            }))
          }
        } else {
          promises.push(post_to_discourse(hash).then(hash => {
            console.log(`Posting "${hash.title}"`)
            db[id] = hash
          }))
        }
      })

      Promise.all(promises).then(async _ => {
        for (const k in db) {
          if (db[k].run_at != now) {
            console.log(`Deleting "${db[k].title}", topic: ${db[k].discourse_topic_id}`)
            try {
              await discourse.delete(`t/${db[k].discourse_topic_id}`)
              delete db[k]
            } catch (e) {
              console.error(`FAILED: deleting ${db[k].discourse_topic_id}: ${e}`)
            }
          }
        }
        fs.writeFile("./db.json", JSON.stringify(db), () => {})
      })

    })
  } catch (error) {
    console.error(error)
  }
}

async function post_to_discourse (hash) {
  return new Promise(async (resolve, reject) => {
    if (hash.discourse_topic_id) {
      try {
        await discourse.put(`t/-/${hash.discourse_topic_id}.json`, {
          title: hash.title
        })
      } catch (e) {
        console.error(`FAILED: updating ${hash.discourse_topic_id}: ${e}`)
      }
      try {
        await discourse.put(`posts/${hash.discourse_post_id}.json`, {
          "post[raw]": generate_post(hash)
        })
      } catch (e) {
        console.error(`FAILED: updating ${hash.discourse_topic_id}, post ${hash.discourse_post_id}: ${e}`)
      }
    } else {
      try {
        const response = await discourse.post("posts.json", {
          category: MOZFEST_CATEGORY_ID,
          title: hash.title,
          raw: generate_post(hash)
        })
        hash.discourse_topic_id = response.data.topic_id
        hash.discourse_post_id = response.data.id
      }
      catch (e) {
        console.error(`FAILED: creating "${hash.title}": ${e}`)
      }
    }
    resolve(hash)
  })
}

function generate_post (hash) {
  return `${hash.authors}

${hash.description.replace("\n", "\n\n")}`
}

main()
