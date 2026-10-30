"""Additive Writer diagnostics. Never substitutes, normalizes or drops Width.

Interface: width_readback(table) -> JSON-safe dict. No writes to UNO objects.
Run at load completion and after pagination; keep both snapshots.
"""
PROPERTIES = ('Width', 'RelativeWidth', 'IsWidthRelative', 'HoriOrient',
              'LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin',
              'TableColumnRelativeSum')

def _value(value):
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [_value(v) for v in value]
    if hasattr(value, 'Position') and hasattr(value, 'IsVisible'):
        return {'Position': value.Position, 'IsVisible': value.IsVisible}
    return {'rawRepr': repr(value)}

def _read(obj, name, direct=False):
    try:
        return {'value': _value(getattr(obj, name) if direct else obj.getPropertyValue(name))}
    except Exception as exc:
        return {'errorType': type(exc).__name__, 'error': str(exc)}

def width_readback(table):
    direct = {name: _read(table, name, True) for name in PROPERTIES}
    api = {name: _read(table, name) for name in PROPERTIES}
    rows = []
    for index in range(table.Rows.Count):
        row = table.Rows.getByIndex(index)
        rows.append({'index': index, 'Height': _read(row, 'Height'),
                     'IsAutoHeight': _read(row, 'IsAutoHeight'),
                     'TableColumnSeparators': _read(row, 'TableColumnSeparators')})
    return {'units': '1/100 mm for Width and margins; relative separator units otherwise',
            'direct': direct, 'getPropertyValue': api,
            'directMatchesPropertyValue': direct == api,
            'TableColumnSeparators': _read(table, 'TableColumnSeparators'),
            'rows': rows,
            'widthSubstitutionApplied': False}
