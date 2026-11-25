"""Application settings, read from environment variables / backend/.env.

Everything that changes between the developer's machine and the CESMAC server lives here,
so moving to production is a configuration change, never a code change.
"""
from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="FOTOMAC_", env_file=BACKEND_DIR / ".env", extra="ignore"
    )

    database_url: str
    test_database_url: str | None = None

    # Object storage (SeaweedFS speaks the S3 protocol).
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str = "fotomac-acervo"
    s3_region: str = "us-east-1"  # S3 clients require one; SeaweedFS ignores it.

    # Facial recognition engine of a FRESH installation (see app/face/factory.py). After that, the
    # administrator chooses it in the panel and the choice lives in the database.
    face_engine: str = "sface"
    # Folder with the model files (ONNX). Not versioned: infra/setup_local.sh downloads them.
    face_models_dir: Path = BACKEND_DIR / "models"
    map_file: Path = BACKEND_DIR / "data" / "map" / "brasil.pmtiles"   # infra/build_map.sh

    # FACTORY defaults of parameters the administrator can change in the panel (app/parameters.py).
    # Detection confidence: 0.50 is the value of fotomac-lab's Test 1 for YuNet (MIN_DET_SCORE), kept
    # so production behaves like the model that was measured. The similarity threshold is not here:
    # each engine brings its own calibrated value (factory.ENGINES).
    min_detection_score: float = 0.5
    # Query face only: smallest accepted face side, in pixels, in the visitor's selfie.
    min_query_face_side: int = 40
    max_results_per_search: int = 200

    # Web front-end (Expo) — used to build the links sent by e-mail and for CORS.
    frontend_url: str = "http://localhost:8081"
    cors_origins: list[str] = ["http://localhost:8081"]

    # Authentication.
    session_hours: int = 8                  # one working day; then log in again
    remember_days: int = 30                 # "Manter conectado" checked: a personal computer
    # Without "Manter conectado", a session with no use for this long ends (every profile, the admin too).
    # 15 minutes: chosen by the author on 31/10/2026, after testing with 5.
    idle_minutes: int = 15
    cookie_secure: bool = False             # True in production (HTTPS only)
    activation_link_hours: int = 24
    reset_link_minutes: int = 30
    max_failed_logins: int = 5
    lockout_minutes: int = 15

    # E-mail adapter: "outbox" writes the messages to backend/outbox/ (development only); "smtp" sends them
    # through the institution's mail server (app/notifications/smtp_sender.py, manual section 3.6).
    email_sender: str = "outbox"
    email_from: str = "FOTOMAC <nao-responda@cesmac.edu.br>"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_security: str = "starttls"         # "starttls" (port 587) or "ssl" (port 465); never unencrypted
    smtp_username: str | None = None        # empty: the server accepts the FOTOMAC machine by its address (relay)
    smtp_password: SecretStr | None = None  # SecretStr: never printed in logs or error messages
    smtp_timeout_seconds: int = 15          # a mail server that does not answer cannot hold a request forever

    # Background queue (facial indexing, packages) inside the API process. Tests turn it off
    # and drive the queue step by step.
    background_worker: bool = True

    # DEVELOPMENT ONLY: logs the numbers measured by the liveness check of the public search
    # (how far the head turned in each step, how alike the poses are). Numbers only — never an
    # image, a frame or a vector. Used to confirm the movement convention with real faces; off
    # in production.
    diagnostics_log: bool = False

    # Key of the pgcrypto encryption of the hired photographer's CPF and birth date.
    # Lives ONLY here (backend/.env, outside the database): a copy of the database alone does not
    # reveal them. Required to create temporary accounts.
    identity_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
