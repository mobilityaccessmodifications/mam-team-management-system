from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'tests/performance-review-completion-helper-cli.py'
source = path.read_text()
changes = {
    "paths=['scripts/deploy-performance-review-completion.py',": "paths=['scripts/deploy-performance-review-completion-with-master.py','scripts/deploy-performance-review-completion.py',",
    "helper=root/'scripts/deploy-performance-review-completion.py';": "helper=root/'scripts/deploy-performance-review-completion-with-master.py';",
    " if mode=='pending-master' or p.name.split('_',1)[0]<='20261017103000'": "",
}
for before, after in changes.items():
    assert source.count(before) == 1
    source = source.replace(before, after)
exec(compile(source, str(path), 'exec'), {'__name__': '__main__', '__file__': str(path)})
