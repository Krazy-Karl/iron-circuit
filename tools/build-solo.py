# Génère la version solo en un seul fichier (solo/iron-circuit.html) à partir du client LAN
# et de la simulation partagée. Usage : python3 tools/build-solo.py
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
pub = root / 'public'
html = (pub / 'index.html').read_text(encoding='utf-8')
sim = (pub / 'sim.js').read_text(encoding='utf-8')
head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
head = head.replace('<title>Iron Circuit LAN</title>', '<title>Iron Circuit</title>')
body = body.replace('<script src="three.min.js"></script>', '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>')
body = body.replace('<script src="sim.js"></script>', '<script>window.IRON_SOLO = true;</script>\n<script>\n' + sim + '</script>')
out = '<!doctype html>\n<html lang="fr">\n<head>' + head + '</head>\n<body>' + body + '</body>\n</html>\n'
assert 'IRON_SOLO' in out and 'cdnjs' in out
(root / 'solo').mkdir(exist_ok=True)
(root / 'solo' / 'iron-circuit.html').write_text(out, encoding='utf-8')
print('solo/iron-circuit.html :', len(out), 'octets')
