#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé. Télécharge la version LTS sur https://nodejs.org puis relance ce fichier."
  read -n 1 -s -r -p "Appuie sur une touche pour fermer."
  exit 1
fi
node server.js "$@"
