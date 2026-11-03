"""Writes models/style.onnx for the mlstyle sample — no onnx package needed.

The net is one 1x1 convolution (a 3x3 colour matrix plus a bias) over an NCHW float image
[1, 3, H, W] with dynamic H and W: small enough to read, real enough to run on any execution
provider. mlstyle.cpp holds the same matrix for its CPU path; the two must agree.

    python tools/make_model.py        (from the sample's folder)
"""
import os
import struct

# Warm "film" grade: rows are output R, G, B; columns input R, G, B. Keep in step with kMatrix
# and kBias in mlstyle.cpp.
MATRIX = [
    [0.90, 0.25, 0.05],
    [0.10, 0.80, 0.10],
    [0.05, 0.20, 0.65],
]
BIAS = [0.02, 0.01, 0.04]


def varint(n):
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def key(field, wire):
    return varint((field << 3) | wire)


def f_varint(field, n):
    return key(field, 0) + varint(n)


def f_bytes(field, data):
    if isinstance(data, str):
        data = data.encode('utf8')
    return key(field, 2) + varint(len(data)) + data


def tensor(name, dims, floats):
    body = b''.join(f_varint(1, d) for d in dims)
    body += f_varint(2, 1)  # FLOAT
    body += f_bytes(9, struct.pack('<%df' % len(floats), *floats))  # raw_data
    body += f_bytes(8, name)
    return body


def dim(value=None, param=None):
    return f_varint(1, value) if value is not None else f_bytes(2, param)


def value_info(name, dims):
    shape = b''.join(f_bytes(1, d) for d in dims)
    tensor_type = f_varint(1, 1) + f_bytes(2, shape)
    return f_bytes(1, name) + f_bytes(2, f_bytes(1, tensor_type))


def node(inputs, outputs, name, op):
    body = b''.join(f_bytes(1, i) for i in inputs)
    body += b''.join(f_bytes(2, o) for o in outputs)
    body += f_bytes(3, name) + f_bytes(4, op)
    return body


weights = [MATRIX[o][i] for o in range(3) for i in range(3)]  # [out, in, 1, 1]
graph = f_bytes(1, node(['image', 'W', 'B'], ['styled'], 'grade', 'Conv'))
graph += f_bytes(2, 'mlstyle')
graph += f_bytes(5, tensor('W', [3, 3, 1, 1], weights))
graph += f_bytes(5, tensor('B', [3], BIAS))
graph += f_bytes(11, value_info('image', [dim(1), dim(3), dim(param='H'), dim(param='W')]))
graph += f_bytes(12, value_info('styled', [dim(1), dim(3), dim(param='H'), dim(param='W')]))

model = f_varint(1, 7)  # ir_version
model += f_bytes(2, 'premation-mlstyle')
model += f_bytes(7, graph)
model += f_bytes(8, f_bytes(1, '') + f_varint(2, 13))  # opset 13

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', 'models', 'style.onnx')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(model)
print('wrote', os.path.normpath(out), len(model), 'bytes')
