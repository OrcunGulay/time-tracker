"""
Komut satiri giris noktasi.

    python -m tt_agent --config config.yaml
    python -m tt_agent --mode silent --api-key tt_xxx
    python -m tt_agent --check

Cikis kodlari:
    0 basarili
    1 calisma zamani hatasi
    2 yapilandirma hatasi
    3 kimlik dogrulama hatasi
"""
from __future__ import annotations

import sys
from typing import List, Optional

from . import AGENT_NAME, __version__


def main(argv: Optional[List[str]] = None) -> int:
    from .config import build_arg_parser, load_config

    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.version:
        print("%s v%s" % (AGENT_NAME, __version__))
        return 0

    try:
        config = load_config(argv)
    except Exception as exc:  # noqa: BLE001 - kullaniciya net mesaj vermek icin
        print("[hata] Yapilandirma okunamadi: %s" % exc, file=sys.stderr)
        return 2

    if args.check:
        from .diagnostics import run_diagnostics

        return run_diagnostics(config)

    from .agent import AgentRuntime
    from .auth import AuthError

    runtime: Optional[AgentRuntime] = None
    try:
        runtime = AgentRuntime(config)
        runtime.run()
        return 0
    except AuthError as exc:
        print("[hata] Kimlik dogrulama: %s" % exc, file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("\n[durduruldu] Kullanici tarafindan durduruldu.", file=sys.stderr)
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback

        print("[hata] Agent coktu: %s" % exc, file=sys.stderr)
        traceback.print_exc()
        return 1
    finally:
        if runtime is not None:
            try:
                runtime.shutdown()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
