const fs = require('fs').promises

const DISCOURSE_URL = process.env.DISCOURSE_URL

async function main () {
  let redirect = ""
  const db = await fs.readFile("./db.json", "utf8")
  const data = db ? JSON.parse(db) : {}

  for (k in data) {
    const val = data[k]
    redirect += `/2019/${k} ${DISCOURSE_URL}t/${val.topic_id} 302\n`
  }

  await fs.writeFile("./_redirects", redirect, "utf8")
}

main()
