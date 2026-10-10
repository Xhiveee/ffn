Callback injectors call a handler method from inside the target method.

### 2. Building Handler Methods

The handler receives the target's arguments followed by a `CallbackInfo`.

### 3. Cancellable Injections

Set `cancellable = true` on `@Inject` to return early from the target method.

```java
@Inject(method = "setPos", at = @At("HEAD"), cancellable = true)
protected void onSetPos(int x, int y, CallbackInfo ci) {
    if (x == 0 && y == 0) ci.cancel();
}
```

#### 3.1 Stuff You Already Know&#8482;

Calling `cancel()` on a non-cancellable injection throws an exception.
