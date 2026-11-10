FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0
WORKDIR /app
COPY backend_py ./backend_py
USER 65534:65534
ENV DATA_DIR=/tmp/locket-ai-generated
EXPOSE 8787
CMD ["python", "-m", "backend_py.server"]
