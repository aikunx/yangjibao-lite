// 验证腾讯指数解析逻辑（与 index.html 中的实现保持一致）。
// 运行：dart run tool/verify_market.dart

import 'dart:convert';
import 'dart:io';

/// 与前端 api.indices 相同的解析规则
List<Map<String, dynamic>> parseIndices(String text) {
  final out = <Map<String, dynamic>>[];
  final re = RegExp(r'v_(\w+)="([^"]*)"');
  for (final m in re.allMatches(text)) {
    final code = m.group(1) ?? '';
    final f = (m.group(2) ?? '').split('~');
    if (f.length < 33) continue;

    final name = f[1];
    final price = double.tryParse(f[3]) ?? 0;
    final prevClose = double.tryParse(f[4]) ?? 0;
    final change = double.tryParse(f[31]);
    final pct = double.tryParse(f[32]);

    out.add({
      'code': code,
      'name': name,
      'price': price,
      'change': change ?? (price - prevClose),
      'pct': pct ?? (prevClose != 0 ? (price - prevClose) / prevClose * 100 : 0),
    });
  }
  return out;
}

Future<void> main() async {
  const url = 'https://qt.gtimg.cn/q=sh000001,sz399001,sz399006';
  final client = HttpClient();
  try {
    final req = await client.getUrl(Uri.parse(url));
    req.headers.set('User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    final resp = await req.close();
    final bytes = await resp.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    final text = const Utf8Decoder(allowMalformed: true).convert(bytes);

    print('HTTP ${resp.statusCode}, 原始长度 ${text.length}');
    print('');

    final list = parseIndices(text);
    if (list.isEmpty) {
      print('解析失败：未匹配到任何指数');
      print('原文前 200 字：${text.substring(0, text.length.clamp(0, 200))}');
      return;
    }

    for (final q in list) {
      final chg = (q['change'] as num).toDouble();
      final pct = (q['pct'] as num).toDouble();
      print('${q['name']}  (${q['code']})');
      print('  当前 ${(q['price'] as num).toStringAsFixed(2)}  '
          '${chg >= 0 ? "+" : ""}${chg.toStringAsFixed(2)}  '
          '${pct >= 0 ? "+" : ""}${pct.toStringAsFixed(2)}%');
    }
    print('');
    print('共 ${list.length} 个指数，解析正常');
  } finally {
    client.close(force: true);
  }
}
