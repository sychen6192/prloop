---
applyTo: "**/*.java"
---

# Java review rules

prloop dedupes tool and model findings downstream — report what you see; pure
formatting/naming-convention output is the only thing left to linters. The focus below is
problems that need context to judge.

## Concurrency

Each rule: what to look for → the shape that fails → the shape that holds → why it matters.

### Compound operations on a volatile field

`count++`, `x += 1`, `flag = !flag` on a `volatile` field. volatile guarantees visibility,
not atomicity.

```java
// bad
private volatile int hits;
public void record() { hits++; }
```

```java
// good
private final AtomicInteger hits = new AtomicInteger();
public void record() { hits.incrementAndGet(); }
```

Why: `hits++` is a read, an add and a write. Two threads read the same value and both write
value+1; one increment is lost, silently, only under load. A lock works too.

### Check-then-act on a concurrent collection

`if (!map.containsKey(k)) map.put(k, v)`. Each call is atomic on its own; together they
are not.

```java
// bad
if (!cache.containsKey(key)) {
    cache.put(key, load(key));
}
return cache.get(key);
```

```java
// good
return cache.computeIfAbsent(key, k -> load(k));
// putIfAbsent(key, v) and merge(key, v, fn) are the other single-step forms
```

Why: two threads pass the `containsKey` check together, both load, and the second `put`
overwrites the first — a duplicated load at best, a lost update when the value carries
state.

### static SimpleDateFormat or Calendar

Neither is thread safe, and a static instance is shared by every thread that formats.

```java
// bad
private static final SimpleDateFormat ISO = new SimpleDateFormat("yyyy-MM-dd");
String render(Date d) { return ISO.format(d); }
```

```java
// good
private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_LOCAL_DATE;
String render(LocalDate d) { return ISO.format(d); }
```

Why: `SimpleDateFormat` keeps its working state in fields, so concurrent calls corrupt each
other and produce wrong dates rather than exceptions — which is why it reaches production.
`DateTimeFormatter` is immutable.

### Synchronizing on a reassigned field, a boxed primitive, or an interned String

The lock object must be `final` and private to the class.

```java
// bad
private Object lock = new Object();
void reset() { lock = new Object(); }
void work() { synchronized (lock) { state++; } }
```

```java
// good
private final Object lock = new Object();
void work() { synchronized (lock) { state++; } }
```

Why: a reassigned lock lets two threads hold "the" lock at once — one on the old object, one
on the new. A boxed primitive (`Integer`, `Boolean`) or a string literal is worse in the same
way: the JVM shares those instances, so unrelated code may be synchronizing on the very same
object and the lock's scope widens unexpectedly.

### Calling foreign code while holding a lock

RPC, callbacks, I/O or listener notification inside `synchronized`.

```java
// bad
synchronized (this) {
    orders.add(order);
    notifier.send(order);   // network call under the lock
}
```

```java
// good
synchronized (this) { orders.add(order); }
notifier.send(order);
```

Why: the lock is held for as long as the network takes, so every other caller queues behind a
remote timeout — and if the callee takes a lock of its own, the two lock orders can invert
and deadlock.

### synchronized inside a virtual thread

```java
// bad
Thread.ofVirtual().start(() -> {
    synchronized (lock) { blockingCall(); }
});
```

```java
// good (lock is a ReentrantLock)
Thread.ofVirtual().start(() -> {
    lock.lock();
    try { blockingCall(); } finally { lock.unlock(); }
});
```

Why: on JDK 21–23 a virtual thread that blocks inside `synchronized` pins its carrier thread,
so the carrier cannot be reused; under load the carriers drain and virtual threads stop
scaling, which is the one thing they exist for. `ReentrantLock` releases the carrier while
waiting. (JEP 491 lifts the pinning in JDK 24; check the project's target.)

## Two classes the static tools have no rules for — always judge these by hand

- **`Collectors.toMap` without a merge function.** A duplicate key throws
  `IllegalStateException: Duplicate key`; and because it is built on `HashMap::merge`, a
  **null value causes an NPE** (unlike `HashMap.put`).
- **Shared mutable state accessed inside a parallel stream.** Parallel streams share the
  whole JVM's `ForkJoinPool.commonPool()`, so one blocking task drags down every parallel
  stream in the process.

## Stream

- **Reusing a consumed stream** → `IllegalStateException: stream has already been operated upon or closed`.
- **`peek` can be skipped entirely.** If the source is SIZED and the terminal operation is
  `count()`, the implementation may elide the whole pipeline. Do not put side-effecting logic
  in `peek`.
- **`Files.lines` / `Files.walk` hold a file handle** and must be used in try-with-resources.
- **Side effects in a behavioral parameter.** The javadoc states explicitly that
  implementations may elide operations and that side effects are not guaranteed visible to
  other threads.

## Spring `@Transactional`

Each rule: what to look for → the shape that fails → the shape that holds → why it matters.

### Self-invocation

Calling your own `@Transactional` method from inside the same class.

```java
// bad
public void importAll(List<Row> rows) {
    for (Row r : rows) save(r);   // same class: the proxy never sees this call
}
@Transactional
public void save(Row r) { repo.insert(r); }
```

```java
// good
@Transactional
public void importAll(List<Row> rows) {
    for (Row r : rows) repo.insert(r);
}
```

Why: Spring applies `@Transactional` through a proxy wrapped around the bean. A call from
inside the same class goes straight to `this`, bypasses the proxy, and no transaction is ever
started — each `save` autocommits on its own.

### Checked exceptions do not roll back by default

Only `RuntimeException` and `Error` trigger a rollback.

```java
// bad
@Transactional
public void transfer(Account from, Account to, long amount) throws LedgerException {
    ledger.debit(from, amount);
    ledger.credit(to, amount);   // throws LedgerException: the debit stays committed
}
```

```java
// good
@Transactional(rollbackFor = Exception.class)
public void transfer(Account from, Account to, long amount) throws LedgerException {
    ledger.debit(from, amount);
    ledger.credit(to, amount);
}
```

Why: a checked exception propagates out of the method without marking the transaction
rollback-only, so the interceptor commits everything that happened before it.

### readOnly = true silently discards writes

`readOnly = true` sets Hibernate to `FlushMode.MANUAL`.

```java
// bad
@Transactional(readOnly = true)
public void markSeen(long id) {
    Notification n = repo.findById(id);
    n.setSeen(true);   // dirty checking is off: never flushed
}
```

```java
// good
@Transactional
public void markSeen(long id) {
    repo.findById(id).setSeen(true);
}
```

Why: the modified entity is never written and nothing says so — the method works in a
debugger, and the write is lost in production.

### External HTTP/RPC inside a transaction

```java
// bad
@Transactional
public void placeOrder(Order o) {
    orders.save(o);
    paymentGateway.charge(o);   // seconds, while the connection is held
}
```

```java
// good
public void placeOrder(Order o) {
    orders.save(o);               // its own short transaction
    paymentGateway.charge(o);
    orders.markPaid(o.id());      // and another
}
```

Why: a database connection is held for the whole round trip, so a slow gateway exhausts the
pool for every other request — and a charge that succeeded before a later rollback cannot be
undone (see side effects before commit, below).

### @Transactional combined with @Async

Transaction synchronization is bound to a ThreadLocal and does not propagate to the new
thread.

```java
// bad
@Transactional
public void checkout(Cart cart) {
    orders.save(cart.toOrder());
    mailer.sendReceipt(cart);   // @Async: another thread, outside this transaction
}
```

```java
// good
@Transactional
public void checkout(Cart cart) {
    orders.save(cart.toOrder());
    events.publish(new OrderPlaced(cart));   // handled AFTER_COMMIT, see below
}
```

Why: the `@Async` method runs on an executor thread with no transaction, so it reads data the
caller has not committed yet — or cannot see it at all — and its own writes commit
independently of the caller's rollback.

### Side effects before commit

Sending messages, writing to a cache, calling a webhook while the transaction is still open.

```java
// bad
@Transactional
public void register(User u) {
    users.save(u);
    mailer.sendWelcome(u);   // sent even if the commit fails
}
```

```java
// good
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onRegistered(UserRegistered e) {
    mailer.sendWelcome(e.user());
}
```

Why: a message published or an email sent before commit cannot be taken back when the
transaction rolls back — the world has been told about a row that does not exist.

### Non-public methods are not intercepted

```java
// bad
@Transactional
protected void applyAll(List<Change> changes) {
    for (Change c : changes) repo.apply(c);
}
```

```java
// good
@Transactional
public void applyAll(List<Change> changes) {
    for (Change c : changes) repo.apply(c);
}
```

Why: under JDK (interface) proxies only public methods are proxied; the annotation on a
non-public method is silently ignored, exactly like self-invocation. Spring 6 with CGLIB
proxies honours protected and package-private methods, but the proxy mode is a deployment
detail the code cannot rely on.

## JPA / Hibernate

- **N+1 queries.** → `JOIN FETCH`, `@EntityGraph`, `@BatchSize`, or a DTO projection.
- **Pagination combined with `JOIN FETCH` on a collection** → Hibernate loads the whole
  result set into memory and paginates there (the `HHH000104` warning); with enough data,
  straight to OOM.
- **Fetching several List-typed associations at once** → `MultipleBagFetchException`.
- **Entity `equals`/`hashCode` based on a generated ID.** Before flush the ID is null, so an
  object put into a `HashSet` can no longer be found.
- **`FetchType.EAGER`** is almost always the wrong default.

## Resources and exceptions

- **Not using try-with-resources.** Streams, connections, and readers are not closed on
  exception paths.
- **Swallowing `InterruptedException`.** At minimum call
  `Thread.currentThread().interrupt()`.
- **`Optional.get()` without a preceding `isPresent()`**, and using `Optional` as a parameter
  type.
