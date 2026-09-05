# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ['bot.py'],
    pathex=['D:/Projetos/1.Autorais/idledex-bot'],
    binaries=[],
    datas=[
        ('dashboard.html', '.'),
        ('visualizer.html', '.'),
    ],
    hiddenimports=[
        'websockets',
        'websockets.asyncio',
        'websockets.asyncio.client',
        'websockets.asyncio.connection',
        'websockets.frames',
        'websockets.http11',
        'websockets.legacy',
        'websockets.legacy.client',
        'websockets.extensions.permessage_deflate',
        'aiohttp',
        'aiohttp.client',
        'aiohttp.client_reqrep',
        'aiohttp.helpers',
        'aiohttp.multipart',
        'aiohttp.payload',
        'aiohttp.web',
        'aiohttp.web_request',
        'aiohttp.web_response',
        'aiohttp.web_protocol',
        'multidict',
        'yarl',
        'asyncio',
        'config',
        'economy',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='idledex-bot',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='idledex-bot',
)