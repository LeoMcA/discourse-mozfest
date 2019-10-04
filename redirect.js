const fs = require('fs').promises

const DISCOURSE_URL = process.env.DISCOURSE_URL

async function main () {
  let redirect = `/ ${DISCOURSE_URL} 302\n`
  redirect += `/2019 ${DISCOURSE_URL}c/mozfest 302\n`
  const db = await fs.readFile("./db.json", "utf8")
  const data = db ? JSON.parse(db) : {}

  for (k in data) {
    const val = data[k]
    if (val.duplicate_of) {
      const original = data[val.duplicate_of]
      redirect += `/2019/${k} ${DISCOURSE_URL}t/${original.topic_id} 302\n`
    } else {
      redirect += `/2019/${k} ${DISCOURSE_URL}t/${val.topic_id} 302\n`
    }
  }

  await fs.writeFile("./_redirects", redirect, "utf8")
}

main()
