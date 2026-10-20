# -*- coding: utf-8 -*-
"""
把单文件 assets/index.html 拆成 src/ 下的可维护模块。

原则：**只做位置切片，不做任何内容改写**。
拼回去必须与原文件逐字节一致（由 verify 保证），
否则说明拆分点选错了，宁可报错也不要生成一个"看起来对"的产物。
"""
import io, os, re, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_HTML = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'index.html')
OUT = os.path.join(ROOT, 'src')

s = io.open(SRC_HTML, encoding='utf-8').read()
orig_sha = hashlib.sha256(s.encode('utf-8')).hexdigest()

# 收集所有 style / script 块的精确位置
blocks = []
for m in re.finditer(r'<style>[\s\S]*?</style>|<script>[\s\S]*?</script>', s):
    tag = 'style' if m.group(0).startswith('<style>') else 'script'
    inner = m.group(0)[len('<' + tag + '>'):-len('</' + tag + '>')]
    blocks.append({'start': m.start(), 'end': m.end(), 'tag': tag, 'inner': inner})

print('找到 %d 个块：%s' % (len(blocks), [b['tag'] for b in blocks]))

# 只处理我们知道的三块：head-init(script) / style / app(script)
scripts = [b for b in blocks if b['tag'] == 'script']
styles = [b for b in blocks if b['tag'] == 'style']
assert len(scripts) == 2, '期望恰好 2 个 script 块，实际 %d' % len(scripts)
assert len(styles) == 1, '期望恰好 1 个 style 块，实际 %d' % len(styles)

head_init, app_js = scripts[0], scripts[1]
style = styles[0]

# 依据位置把整份文件切成 7 段：之前 / <script> / 中间 / <style> / 中间 / <script> / 之后
parts = []
cursor = 0
for b in [head_init, style, app_js]:
    parts.append(s[cursor:b['start']])
    parts.append(None)          # 占位，稍后用文件引用替换
    cursor = b['end']
parts.append(s[cursor:])

os.makedirs(OUT, exist_ok=True)

def w(name, text):
    p = os.path.join(OUT, name)
    io.open(p, 'w', encoding='utf-8', newline='').write(text)
    print('  %-22s %7d 字节' % (name, len(text.encode('utf-8'))))

w('01-head-init.js', head_init['inner'])
w('02-style.css', style['inner'])
w('04-app.js', app_js['inner'])

# 骨架：把三块内容换成占位标记
SHELL = '<!--@@SLOT@@-->'
shell = parts[0] + SHELL + parts[2] + SHELL + parts[4] + SHELL + parts[6]
io.open(os.path.join(OUT, '00-shell.html'), 'w', encoding='utf-8', newline='').write(shell)
print('  00-shell.html          占位符 x3')

io.open(os.path.join(OUT, 'ORIGIN_SHA256.txt'), 'w', encoding='ascii', newline='').write(orig_sha + '\n')
print('原文件 sha256:', orig_sha)
print('拆分完成。下一步跑 tool/concat.py 验证能否原样拼回。')
