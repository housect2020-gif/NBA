name: Save game odds and scores

on:
  schedule:
    # every 10 minutes from 10 AM to 1 AM Eastern (UTC times; shifts 1 hour with daylight saving)
    - cron: '*/10 14-23,0-5 * * *'
  workflow_dispatch: {}   # lets you run it by hand from the Actions tab

permissions:
  contents: read

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Save games to Supabase
        env:
          SUPABASE_URL: https://owobaxyhkrdpgxclewzp.supabase.co
          SUPABASE_SECRET_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}
        run: node scripts/update_games.mjs
