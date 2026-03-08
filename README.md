# OutdoorsV5

What if the expensive parts of the pipeline didn't need to be expensive?

Outdoors-3 used Claude for everything -- including task classification and memory retrieval, which are fundamentally *pattern matching* problems. V5 replaces those two phases with local ML models that run in milliseconds instead of seconds, for free instead of dollars.

**Phase A -- Classification:** TF-IDF + Logistic Regression. Trained on accumulated task data. Tells the system what kind of request it's looking at. ~80ms.

**Phase B -- Memory retrieval:** TF-IDF keyword matching against stored knowledge. Finds relevant context without an API call. ~20ms.

**Phase C onward:** Claude handles execution -- the part that actually requires reasoning.

The ML models run in a persistent Python subprocess that stays warm between requests. Communication is newline-delimited JSON over stdin/stdout. No HTTP overhead, no cold starts, no serialization libraries. Just pipes.

```
outdoorsv4/ml/          training scripts, models, inference server
outdoorsv4/ml/models/   serialized TF-IDF vectorizers + classifiers
```

The routine work (classification, retrieval) doesn't need frontier models. Save those for where they matter. Two API calls became two local inferences -- faster, cheaper, and honestly more reliable for these specific tasks.

```bash
pip install scikit-learn joblib numpy
cd outdoorsv1/backend && npm install && node server.js
```
