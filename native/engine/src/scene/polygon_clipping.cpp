#include "polygon_clipping.hpp"

#include <algorithm>
#include <cmath>
#include <deque>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

namespace premation::scene::pc {

// ── robust-predicates 3.0.3 orient2d ────────────────────────────────────────
namespace {

constexpr double kEpsilonRp = 1.1102230246251565e-16;
constexpr double kSplitter = 134217729;
constexpr double kResultErrBound = (3 + 8 * kEpsilonRp) * kEpsilonRp;
constexpr double kCcwErrBoundA = (3 + 16 * kEpsilonRp) * kEpsilonRp;
constexpr double kCcwErrBoundB = (2 + 12 * kEpsilonRp) * kEpsilonRp;
constexpr double kCcwErrBoundC = (9 + 64 * kEpsilonRp) * kEpsilonRp * kEpsilonRp;

/// fast_expansion_sum_zeroelim.
int rp_sum(int elen, const double* e, int flen, const double* f, double* h) {
  double q = 0, qnew = 0, hh = 0, bvirt = 0;
  double enow = e[0];
  double fnow = f[0];
  int eindex = 0;
  int findex = 0;
  if ((fnow > enow) == (fnow > -enow)) {
    q = enow;
    enow = ++eindex < elen ? e[eindex] : 0;
  } else {
    q = fnow;
    fnow = ++findex < flen ? f[findex] : 0;
  }
  int hindex = 0;
  if (eindex < elen && findex < flen) {
    if ((fnow > enow) == (fnow > -enow)) {
      qnew = enow + q;
      hh = q - (qnew - enow);
      enow = ++eindex < elen ? e[eindex] : 0;
    } else {
      qnew = fnow + q;
      hh = q - (qnew - fnow);
      fnow = ++findex < flen ? f[findex] : 0;
    }
    q = qnew;
    if (hh != 0) h[hindex++] = hh;
    while (eindex < elen && findex < flen) {
      if ((fnow > enow) == (fnow > -enow)) {
        qnew = q + enow;
        bvirt = qnew - q;
        hh = q - (qnew - bvirt) + (enow - bvirt);
        enow = ++eindex < elen ? e[eindex] : 0;
      } else {
        qnew = q + fnow;
        bvirt = qnew - q;
        hh = q - (qnew - bvirt) + (fnow - bvirt);
        fnow = ++findex < flen ? f[findex] : 0;
      }
      q = qnew;
      if (hh != 0) h[hindex++] = hh;
    }
  }
  while (eindex < elen) {
    qnew = q + enow;
    bvirt = qnew - q;
    hh = q - (qnew - bvirt) + (enow - bvirt);
    enow = ++eindex < elen ? e[eindex] : 0;
    q = qnew;
    if (hh != 0) h[hindex++] = hh;
  }
  while (findex < flen) {
    qnew = q + fnow;
    bvirt = qnew - q;
    hh = q - (qnew - bvirt) + (fnow - bvirt);
    fnow = ++findex < flen ? f[findex] : 0;
    q = qnew;
    if (hh != 0) h[hindex++] = hh;
  }
  if (q != 0 || hindex == 0) h[hindex++] = q;
  return hindex;
}

double rp_estimate(int elen, const double* e) {
  double q = e[0];
  for (int i = 1; i < elen; ++i) q += e[i];
  return q;
}

/// The two-product expansion (a·b − c·d) as four components, Shewchuk's macro sequence.
void two_two_diff(double a, double b, double c, double d, std::array<double, 4>& out) {
  double bvirt = 0, cc = 0, ahi = 0, alo = 0, bhi = 0, blo = 0;
  const double s1 = a * b;
  cc = kSplitter * a;
  ahi = cc - (cc - a);
  alo = a - ahi;
  cc = kSplitter * b;
  bhi = cc - (cc - b);
  blo = b - bhi;
  const double s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  const double t1 = c * d;
  cc = kSplitter * c;
  ahi = cc - (cc - c);
  alo = c - ahi;
  cc = kSplitter * d;
  bhi = cc - (cc - d);
  blo = d - bhi;
  const double t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  double i = s0 - t0;
  bvirt = s0 - i;
  out[0] = s0 - (i + bvirt) + (bvirt - t0);
  const double j = s1 + i;
  bvirt = j - s1;
  const double z = s1 - (j - bvirt) + (i - bvirt);
  i = z - t1;
  bvirt = z - i;
  out[1] = z - (i + bvirt) + (bvirt - t1);
  const double u3 = j + i;
  bvirt = u3 - j;
  out[2] = j - (u3 - bvirt) + (i - bvirt);
  out[3] = u3;
}

double orient2dadapt(double ax, double ay, double bx, double by, double cx, double cy, double detsum) {
  const double acx = ax - cx;
  const double bcx = bx - cx;
  const double acy = ay - cy;
  const double bcy = by - cy;
  std::array<double, 4> b{};
  two_two_diff(acx, bcy, acy, bcx, b);
  double det = rp_estimate(4, b.data());
  double errbound = kCcwErrBoundB * detsum;
  if (det >= errbound || -det >= errbound) return det;
  double bvirt = ax - acx;
  const double acxtail = ax - (acx + bvirt) + (bvirt - cx);
  bvirt = bx - bcx;
  const double bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
  bvirt = ay - acy;
  const double acytail = ay - (acy + bvirt) + (bvirt - cy);
  bvirt = by - bcy;
  const double bcytail = by - (bcy + bvirt) + (bvirt - cy);
  if (acxtail == 0 && acytail == 0 && bcxtail == 0 && bcytail == 0) return det;
  errbound = kCcwErrBoundC * detsum + kResultErrBound * std::abs(det);
  det += (acx * bcytail + bcy * acxtail) - (acy * bcxtail + bcx * acytail);
  if (det >= errbound || -det >= errbound) return det;
  std::array<double, 4> u{};
  std::array<double, 8> c1{};
  std::array<double, 12> c2{};
  std::array<double, 16> d{};
  two_two_diff(acxtail, bcy, acytail, bcx, u);
  const int c1len = rp_sum(4, b.data(), 4, u.data(), c1.data());
  two_two_diff(acx, bcytail, acy, bcxtail, u);
  const int c2len = rp_sum(c1len, c1.data(), 4, u.data(), c2.data());
  two_two_diff(acxtail, bcytail, acytail, bcxtail, u);
  const int dlen = rp_sum(c2len, c2.data(), 4, u.data(), d.data());
  return d[static_cast<std::size_t>(dlen - 1)];
}

}  // namespace

double orient2d(double ax, double ay, double bx, double by, double cx, double cy) {
  const double detleft = (ay - cy) * (bx - cx);
  const double detright = (ax - cx) * (by - cy);
  const double det = detleft - detright;
  const double detsum = std::abs(detleft + detright);
  if (std::abs(det) >= kCcwErrBoundA * detsum) return det;
  return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
}

namespace {

// ── splaytree 3.2.3 ─────────────────────────────────────────────────────────
template <typename K>
class SplayTree {
 public:
  struct Node {
    K key;
    Node* left = nullptr;
    Node* right = nullptr;
  };
  using Cmp = std::function<int(const K&, const K&)>;
  explicit SplayTree(Cmp cmp) : cmp_(std::move(cmp)) {}

  /// Inserts a key, allows duplicates.
  Node* insert(const K& key) {
    ++size_;
    root_ = insert_node(key, root_);
    return root_;
  }
  /// Adds a key if it is not present; returns the root (the key's node).
  Node* add(const K& key) {
    Node* r = make(key);
    if (root_ == nullptr) {
      ++size_;
      root_ = r;
    }
    Node* i = splay(key, root_);
    const int o = cmp_(key, i->key);
    if (o == 0) {
      root_ = i;
    } else {
      if (o < 0) {
        r->left = i->left;
        r->right = i;
        i->left = nullptr;
      } else {
        r->right = i->right;
        r->left = i;
        i->right = nullptr;
      }
      ++size_;
      root_ = r;
    }
    return root_;
  }
  void remove(const K& key) { root_ = remove_node(key, root_); }
  std::optional<K> pop() {
    Node* t = root_;
    if (t == nullptr) return std::nullopt;
    while (t->left != nullptr) t = t->left;
    K key = t->key;
    root_ = splay(key, root_);
    root_ = remove_node(key, root_);
    return key;
  }
  Node* find(const K& key) {
    if (root_ == nullptr) return nullptr;
    root_ = splay(key, root_);
    return cmp_(key, root_->key) != 0 ? nullptr : root_;
  }
  Node* next(Node* t) {
    Node* e = root_;
    Node* r = nullptr;
    if (t->right != nullptr) {
      for (r = t->right; r->left != nullptr;) r = r->left;
      return r;
    }
    while (e != nullptr) {
      const int i = cmp_(t->key, e->key);
      if (i == 0) break;
      if (i < 0) {
        r = e;
        e = e->left;
      } else {
        e = e->right;
      }
    }
    return r;
  }
  Node* prev(Node* t) {
    Node* e = root_;
    Node* r = nullptr;
    if (t->left != nullptr) {
      for (r = t->left; r->right != nullptr;) r = r->right;
      return r;
    }
    while (e != nullptr) {
      const int i = cmp_(t->key, e->key);
      if (i == 0) break;
      if (i < 0) {
        e = e->left;
      } else {
        r = e;
        e = e->right;
      }
    }
    return r;
  }
  [[nodiscard]] std::size_t size() const noexcept { return size_; }

 private:
  Node* make(const K& key) {
    nodes_.push_back(Node{key, nullptr, nullptr});
    return &nodes_.back();
  }
  Node* splay(const K& i, Node* t) {
    Node header{K{}, nullptr, nullptr};
    Node* l = &header;
    Node* r = &header;
    for (;;) {
      const int c = cmp_(i, t->key);
      if (c < 0) {
        if (t->left == nullptr) break;
        if (cmp_(i, t->left->key) < 0) {
          Node* y = t->left;
          t->left = y->right;
          y->right = t;
          t = y;
          if (t->left == nullptr) break;
        }
        r->left = t;
        r = t;
        t = t->left;
      } else if (c > 0) {
        if (t->right == nullptr) break;
        if (cmp_(i, t->right->key) > 0) {
          Node* y = t->right;
          t->right = y->left;
          y->left = t;
          t = y;
          if (t->right == nullptr) break;
        }
        l->right = t;
        l = t;
        t = t->right;
      } else {
        break;
      }
    }
    l->right = t->left;
    r->left = t->right;
    t->left = header.right;
    t->right = header.left;
    return t;
  }
  Node* insert_node(const K& i, Node* t) {
    Node* node = make(i);
    if (t == nullptr) return node;
    t = splay(i, t);
    const int c = cmp_(i, t->key);
    if (c < 0) {
      node->left = t->left;
      node->right = t;
      t->left = nullptr;
    } else {
      node->right = t->right;
      node->left = t;
      t->right = nullptr;
    }
    return node;
  }
  Node* remove_node(const K& i, Node* t) {
    if (t == nullptr) return nullptr;
    t = splay(i, t);
    if (cmp_(i, t->key) == 0) {
      Node* x = nullptr;
      if (t->left == nullptr) {
        x = t->right;
      } else {
        x = splay(i, t->left);
        x->right = t->right;
      }
      --size_;
      return x;
    }
    return t;
  }

  Cmp cmp_;
  Node* root_ = nullptr;
  std::size_t size_ = 0;
  std::deque<Node> nodes_;  // stable addresses; a removed node is simply unreachable
};

// ── polygon-clipping 0.15.7 ─────────────────────────────────────────────────

constexpr double kEps = std::numeric_limits<double>::epsilon();
constexpr double kEpsSq = kEps * kEps;

/// The FLP comparator.
int flp_cmp(double a, double b) {
  if (-kEps < a && a < kEps) {
    if (-kEps < b && b < kEps) return 0;
  }
  const double ab = a - b;
  if (ab * ab < kEpsSq * a * b) return 0;
  return a < b ? -1 : 1;
}

class CoordRounder {
 public:
  CoordRounder() : tree_([](const double& a, const double& b) { return a > b ? 1 : a < b ? -1 : 0; }) { (void)round(0); }
  double round(double coord) {
    auto* node = tree_.add(coord);
    auto* prevNode = tree_.prev(node);
    if (prevNode != nullptr && flp_cmp(node->key, prevNode->key) == 0) {
      tree_.remove(coord);
      return prevNode->key;
    }
    auto* nextNode = tree_.next(node);
    if (nextNode != nullptr && flp_cmp(node->key, nextNode->key) == 0) {
      tree_.remove(coord);
      return nextNode->key;
    }
    return coord;
  }

 private:
  SplayTree<double> tree_;
};

struct Event;
struct Segment;
struct RingIn;
struct PolyIn;
struct MultiPolyIn;
struct RingOut;
struct PolyOut;

struct Pt {
  double x = 0, y = 0;
  std::vector<Event*> events;  ///< empty = `events === undefined`
};

struct BBox {
  double llx = 0, lly = 0, urx = 0, ury = 0;
};

bool is_in_bbox(const BBox& b, const Pt& p) { return b.llx <= p.x && p.x <= b.urx && b.lly <= p.y && p.y <= b.ury; }

std::optional<BBox> bbox_overlap(const BBox& b1, const BBox& b2) {
  if (b2.urx < b1.llx || b1.urx < b2.llx || b2.ury < b1.lly || b1.ury < b2.lly) return std::nullopt;
  const double lowerX = b1.llx < b2.llx ? b2.llx : b1.llx;
  const double upperX = b1.urx < b2.urx ? b1.urx : b2.urx;
  const double lowerY = b1.lly < b2.lly ? b2.lly : b1.lly;
  const double upperY = b1.ury < b2.ury ? b1.ury : b2.ury;
  return BBox{lowerX, lowerY, upperX, upperY};
}

struct Event {
  Pt* point = nullptr;
  bool isLeft = false;
  Segment* segment = nullptr;
  Event* otherSE = nullptr;
  Event* consumedBy = nullptr;
};

struct State {
  std::vector<RingIn*> rings;
  std::vector<int> windings;
  std::vector<MultiPolyIn*> multiPolys;
};

struct Segment {
  int id = 0;
  Event* leftSE = nullptr;
  Event* rightSE = nullptr;
  std::vector<RingIn*> rings;
  std::vector<int> windings;
  Segment* consumedBy = nullptr;
  Segment* prev = nullptr;
  RingOut* ringOut = nullptr;
  bool prevInResultSet = false;
  Segment* prevInResultV = nullptr;
  State* beforeStateV = nullptr;
  State* afterStateV = nullptr;
  int isInResultV = -1;
};

struct RingIn {
  PolyIn* poly = nullptr;
  bool isExterior = false;
  std::vector<Segment*> segments;
  BBox bbox;
};

struct PolyIn {
  RingIn* exteriorRing = nullptr;
  std::vector<RingIn*> interiorRings;
  MultiPolyIn* multiPoly = nullptr;
  BBox bbox;
};

struct MultiPolyIn {
  std::vector<PolyIn*> polys;
  BBox bbox;
  bool isSubject = false;
};

struct RingOut {
  std::vector<Event*> events;
  PolyOut* poly = nullptr;
  int isExteriorV = -1;
  bool enclosingSet = false;
  RingOut* enclosingV = nullptr;
};

struct PolyOut {
  RingOut* exteriorRing = nullptr;
  std::vector<RingOut*> interiorRings;
};

double cross(double ax, double ay, double bx, double by) { return ax * by - ay * bx; }
double dot(double ax, double ay, double bx, double by) { return ax * bx + ay * by; }

int compare_vector_angles(const Pt& base, const Pt& end1, const Pt& end2) {
  const double res = orient2d(base.x, base.y, end1.x, end1.y, end2.x, end2.y);
  if (res > 0) return -1;
  if (res < 0) return 1;
  return 0;
}

double sine_of_angle(const Pt& shared, const Pt& base, const Pt& angle) {
  const double vbx = base.x - shared.x;
  const double vby = base.y - shared.y;
  const double vax = angle.x - shared.x;
  const double vay = angle.y - shared.y;
  return cross(vax, vay, vbx, vby) / std::sqrt(dot(vax, vay, vax, vay)) / std::sqrt(dot(vbx, vby, vbx, vby));
}
double cosine_of_angle(const Pt& shared, const Pt& base, const Pt& angle) {
  const double vbx = base.x - shared.x;
  const double vby = base.y - shared.y;
  const double vax = angle.x - shared.x;
  const double vay = angle.y - shared.y;
  return dot(vax, vay, vbx, vby) / std::sqrt(dot(vax, vay, vax, vay)) / std::sqrt(dot(vbx, vby, vbx, vby));
}

struct XY {
  double x = 0, y = 0;
};
std::optional<XY> horizontal_intersection(const Pt& pt, XY v, double y) {
  if (v.y == 0) return std::nullopt;
  return XY{pt.x + v.x / v.y * (y - pt.y), y};
}
std::optional<XY> vertical_intersection(const Pt& pt, XY v, double x) {
  if (v.x == 0) return std::nullopt;
  return XY{x, pt.y + v.y / v.x * (x - pt.x)};
}
std::optional<XY> line_intersection(const Pt& pt1, XY v1, const Pt& pt2, XY v2) {
  if (v1.x == 0) return vertical_intersection(pt2, v2, pt1.x);
  if (v2.x == 0) return vertical_intersection(pt1, v1, pt2.x);
  if (v1.y == 0) return horizontal_intersection(pt2, v2, pt1.y);
  if (v2.y == 0) return horizontal_intersection(pt1, v1, pt2.y);
  const double kross = cross(v1.x, v1.y, v2.x, v2.y);
  if (kross == 0) return std::nullopt;
  const double vex = pt2.x - pt1.x;
  const double vey = pt2.y - pt1.y;
  const double d1 = cross(vex, vey, v1.x, v1.y) / kross;
  const double d2 = cross(vex, vey, v2.x, v2.y) / kross;
  const double x1 = pt1.x + d2 * v1.x;
  const double x2 = pt2.x + d1 * v2.x;
  const double y1 = pt1.y + d2 * v1.y;
  const double y2 = pt2.y + d1 * v2.y;
  return XY{(x1 + x2) / 2, (y1 + y2) / 2};
}

int compare_points(const Pt& a, const Pt& b) {
  if (a.x < b.x) return -1;
  if (a.x > b.x) return 1;
  if (a.y < b.y) return -1;
  if (a.y > b.y) return 1;
  return 0;
}

/// V8's Array.prototype.sort for the short arrays the ring walk sorts: the run
/// count (a descending run reversed) then binary insertion — TimSort below 64.
template <typename T, typename C>
void v8_sort(std::vector<T>& work, C&& cmp) {
  const std::size_t n = work.size();
  if (n < 2) return;
  if (n >= 64) {
    std::ranges::stable_sort(work, [&](const T& a, const T& b) { return cmp(a, b) < 0; });
    return;
  }
  // CountAndMakeRun(0, n).
  std::size_t runLength = 2;
  if (n > 1) {
    const bool descending = cmp(work[1], work[0]) < 0;
    T previous = work[1];
    for (std::size_t idx = 2; idx < n; ++idx) {
      const T current = work[idx];
      const double order = cmp(current, previous);
      if (descending ? order >= 0 : order < 0) break;
      previous = current;
      ++runLength;
    }
    if (descending) std::reverse(work.begin(), work.begin() + static_cast<std::ptrdiff_t>(runLength));
  }
  // BinaryInsertionSort(0, runLength, n).
  for (std::size_t start = runLength; start < n; ++start) {
    std::size_t left = 0;
    std::size_t right = start;
    const T pivot = work[start];
    while (left < right) {
      const std::size_t mid = left + ((right - left) >> 1U);
      if (cmp(pivot, work[mid]) < 0) right = mid;
      else left = mid + 1;
    }
    for (std::size_t p = start; p > left; --p) work[p] = work[p - 1];
    work[left] = pivot;
  }
}

class Operation {
 public:
  explicit Operation(OpType type) : type_(type) {}

  MultiPolygon run(const MultiPolygon& subject, const std::vector<MultiPolygon>& clipping) {
    std::vector<MultiPolyIn*> multipolys;
    multipolys.push_back(multi_poly_in(subject, true));
    for (const MultiPolygon& g : clipping) multipolys.push_back(multi_poly_in(g, false));
    numMultiPolys_ = multipolys.size();
    if (type_ == OpType::difference) {
      const MultiPolyIn* subj = multipolys[0];
      std::size_t i = 1;
      while (i < multipolys.size()) {
        if (bbox_overlap(multipolys[i]->bbox, subj->bbox)) ++i;
        else multipolys.erase(multipolys.begin() + static_cast<std::ptrdiff_t>(i));
      }
    }
    if (type_ == OpType::intersection) {
      for (std::size_t i = 0; i < multipolys.size(); ++i) {
        for (std::size_t j = i + 1; j < multipolys.size(); ++j) {
          if (!bbox_overlap(multipolys[i]->bbox, multipolys[j]->bbox)) return {};
        }
      }
    }
    constexpr std::size_t kMaxQueue = 1000000;
    SplayTree<Event*> queue([this](Event* const& a, Event* const& b) { return compare_events(a, b); });
    for (MultiPolyIn* mp : multipolys) {
      for (Event* e : sweep_events(*mp)) {
        queue.insert(e);
        if (queue.size() > kMaxQueue) throw std::runtime_error("polygon-clipping: queue size too big");
      }
    }
    SplayTree<Segment*> tree([](Segment* const& a, Segment* const& b) { return compare_segments(a, b); });
    std::vector<Segment*> segments;
    std::size_t prevQueueSize = queue.size();
    std::optional<Event*> node = queue.pop();
    while (node) {
      Event* evt = *node;
      if (queue.size() == prevQueueSize) throw std::runtime_error("polygon-clipping: unable to pop a sweep event");
      if (queue.size() > kMaxQueue) throw std::runtime_error("polygon-clipping: queue size too big");
      if (segments.size() > kMaxQueue) throw std::runtime_error("polygon-clipping: too many sweep line segments");
      for (Event* e : process(evt, queue, tree, segments)) {
        if (e->consumedBy == nullptr) queue.insert(e);
      }
      prevQueueSize = queue.size();
      node = queue.pop();
    }
    return multi_poly_out(ring_out_factory(segments));
  }

 private:
  // ── construction ──
  Pt* round_pt(double x, double y) {
    points_.push_back(std::make_unique<Pt>());
    Pt* p = points_.back().get();
    p->x = xr_.round(x);
    p->y = yr_.round(y);
    return p;
  }
  Event* make_event(Pt* point, bool isLeft) {
    events_.push_back(std::make_unique<Event>());
    Event* e = events_.back().get();
    point->events.push_back(e);
    e->point = point;
    e->isLeft = isLeft;
    return e;
  }
  Segment* make_segment(Event* leftSE, Event* rightSE, std::vector<RingIn*> rings, std::vector<int> windings) {
    segments_.push_back(std::make_unique<Segment>());
    Segment* s = segments_.back().get();
    s->id = ++segmentId_;
    s->leftSE = leftSE;
    leftSE->segment = s;
    leftSE->otherSE = rightSE;
    s->rightSE = rightSE;
    rightSE->segment = s;
    rightSE->otherSE = leftSE;
    s->rings = std::move(rings);
    s->windings = std::move(windings);
    return s;
  }
  Segment* segment_from_ring(Pt* pt1, Pt* pt2, RingIn* ring) {
    Pt* leftPt = nullptr;
    Pt* rightPt = nullptr;
    int winding = 0;
    const int cmpPts = compare_points(*pt1, *pt2);
    if (cmpPts < 0) {
      leftPt = pt1;
      rightPt = pt2;
      winding = 1;
    } else if (cmpPts > 0) {
      leftPt = pt2;
      rightPt = pt1;
      winding = -1;
    } else {
      throw std::runtime_error("polygon-clipping: tried to create a degenerate segment");
    }
    Event* leftSE = make_event(leftPt, true);
    Event* rightSE = make_event(rightPt, false);
    return make_segment(leftSE, rightSE, {ring}, {winding});
  }
  RingIn* ring_in(const Ring& geomRing, PolyIn* poly, bool isExterior) {
    if (geomRing.empty()) throw std::runtime_error("polygon-clipping: input geometry is not a valid Polygon");
    ringsIn_.push_back(std::make_unique<RingIn>());
    RingIn* r = ringsIn_.back().get();
    r->poly = poly;
    r->isExterior = isExterior;
    Pt* firstPoint = round_pt(geomRing[0][0], geomRing[0][1]);
    r->bbox = BBox{firstPoint->x, firstPoint->y, firstPoint->x, firstPoint->y};
    Pt* prevPoint = firstPoint;
    for (std::size_t i = 1; i < geomRing.size(); ++i) {
      Pt* point = round_pt(geomRing[i][0], geomRing[i][1]);
      if (point->x == prevPoint->x && point->y == prevPoint->y) continue;
      r->segments.push_back(segment_from_ring(prevPoint, point, r));
      if (point->x < r->bbox.llx) r->bbox.llx = point->x;
      if (point->y < r->bbox.lly) r->bbox.lly = point->y;
      if (point->x > r->bbox.urx) r->bbox.urx = point->x;
      if (point->y > r->bbox.ury) r->bbox.ury = point->y;
      prevPoint = point;
    }
    if (firstPoint->x != prevPoint->x || firstPoint->y != prevPoint->y) {
      r->segments.push_back(segment_from_ring(prevPoint, firstPoint, r));
    }
    return r;
  }
  PolyIn* poly_in(const Polygon& geomPoly, MultiPolyIn* multiPoly) {
    polysIn_.push_back(std::make_unique<PolyIn>());
    PolyIn* p = polysIn_.back().get();
    if (geomPoly.empty()) throw std::runtime_error("polygon-clipping: input geometry is not a valid Polygon");
    p->exteriorRing = ring_in(geomPoly[0], p, true);
    p->bbox = p->exteriorRing->bbox;
    for (std::size_t i = 1; i < geomPoly.size(); ++i) {
      RingIn* ring = ring_in(geomPoly[i], p, false);
      if (ring->bbox.llx < p->bbox.llx) p->bbox.llx = ring->bbox.llx;
      if (ring->bbox.lly < p->bbox.lly) p->bbox.lly = ring->bbox.lly;
      if (ring->bbox.urx > p->bbox.urx) p->bbox.urx = ring->bbox.urx;
      if (ring->bbox.ury > p->bbox.ury) p->bbox.ury = ring->bbox.ury;
      p->interiorRings.push_back(ring);
    }
    p->multiPoly = multiPoly;
    return p;
  }
  MultiPolyIn* multi_poly_in(const MultiPolygon& geom, bool isSubject) {
    multisIn_.push_back(std::make_unique<MultiPolyIn>());
    MultiPolyIn* m = multisIn_.back().get();
    constexpr double kInf = std::numeric_limits<double>::infinity();
    m->bbox = BBox{kInf, kInf, -kInf, -kInf};
    for (const Polygon& g : geom) {
      PolyIn* poly = poly_in(g, m);
      if (poly->bbox.llx < m->bbox.llx) m->bbox.llx = poly->bbox.llx;
      if (poly->bbox.lly < m->bbox.lly) m->bbox.lly = poly->bbox.lly;
      if (poly->bbox.urx > m->bbox.urx) m->bbox.urx = poly->bbox.urx;
      if (poly->bbox.ury > m->bbox.ury) m->bbox.ury = poly->bbox.ury;
      m->polys.push_back(poly);
    }
    m->isSubject = isSubject;
    return m;
  }
  static std::vector<Event*> sweep_events(const MultiPolyIn& m) {
    std::vector<Event*> out;
    const auto ringEvents = [&out](const RingIn* r) {
      for (const Segment* s : r->segments) {
        out.push_back(s->leftSE);
        out.push_back(s->rightSE);
      }
    };
    for (const PolyIn* p : m.polys) {
      ringEvents(p->exteriorRing);
      for (const RingIn* r : p->interiorRings) ringEvents(r);
    }
    return out;
  }

  // ── SweepEvent ──
  int compare_events(Event* a, Event* b) {
    const int ptCmp = compare_points(*a->point, *b->point);
    if (ptCmp != 0) return ptCmp;
    if (a->point != b->point) link(a, b);
    if (a->isLeft != b->isLeft) return a->isLeft ? 1 : -1;
    return compare_segments(a->segment, b->segment);
  }
  void link(Event* self, Event* other) {
    if (other->point == self->point) throw std::runtime_error("polygon-clipping: tried to link already linked events");
    const std::vector<Event*> otherEvents = other->point->events;
    for (Event* evt : otherEvents) {
      self->point->events.push_back(evt);
      evt->point = self->point;
    }
    check_for_consuming(self);
  }
  void check_for_consuming(Event* self) {
    const std::size_t numEvents = self->point->events.size();
    for (std::size_t i = 0; i < numEvents; ++i) {
      Event* evt1 = self->point->events[i];
      if (evt1->segment->consumedBy != nullptr) continue;
      for (std::size_t j = i + 1; j < numEvents; ++j) {
        Event* evt2 = self->point->events[j];
        if (evt2->consumedBy != nullptr) continue;
        if (evt1->otherSE->point != evt2->otherSE->point) continue;
        consume(evt1->segment, evt2->segment);
      }
    }
  }
  std::vector<Event*> available_linked_events(Event* self) {
    std::vector<Event*> out;
    for (Event* evt : self->point->events) {
      if (evt != self && evt->segment->ringOut == nullptr && is_in_result(evt->segment)) out.push_back(evt);
    }
    return out;
  }

  // ── Segment ──
  static int compare_point(const Segment* s, const Pt& point) {
    const Pt& lPt = *s->leftSE->point;
    const Pt& rPt = *s->rightSE->point;
    if ((point.x == lPt.x && point.y == lPt.y) || (point.x == rPt.x && point.y == rPt.y)) return 0;
    const XY v{rPt.x - lPt.x, rPt.y - lPt.y};
    if (lPt.x == rPt.x) {
      if (point.x == lPt.x) return 0;
      return point.x < lPt.x ? 1 : -1;
    }
    const double yDist = (point.y - lPt.y) / v.y;
    const double xFromYDist = lPt.x + yDist * v.x;
    if (point.x == xFromYDist) return 0;
    const double xDist = (point.x - lPt.x) / v.x;
    const double yFromXDist = lPt.y + xDist * v.y;
    if (point.y == yFromXDist) return 0;
    return point.y < yFromXDist ? -1 : 1;
  }
  static bool is_an_endpoint(const Segment* s, const Pt& pt) {
    const Pt& l = *s->leftSE->point;
    const Pt& r = *s->rightSE->point;
    return (pt.x == l.x && pt.y == l.y) || (pt.x == r.x && pt.y == r.y);
  }
  static BBox seg_bbox(const Segment* s) {
    const double y1 = s->leftSE->point->y;
    const double y2 = s->rightSE->point->y;
    return BBox{s->leftSE->point->x, y1 < y2 ? y1 : y2, s->rightSE->point->x, y1 > y2 ? y1 : y2};
  }
  static int compare_segments(const Segment* a, const Segment* b) {
    const double alx = a->leftSE->point->x;
    const double blx = b->leftSE->point->x;
    const double arx = a->rightSE->point->x;
    const double brx = b->rightSE->point->x;
    if (brx < alx) return 1;
    if (arx < blx) return -1;
    const double aly = a->leftSE->point->y;
    const double bly = b->leftSE->point->y;
    const double ary = a->rightSE->point->y;
    const double bry = b->rightSE->point->y;
    if (alx < blx) {
      if (bly < aly && bly < ary) return 1;
      if (bly > aly && bly > ary) return -1;
      const int aCmpBLeft = compare_point(a, *b->leftSE->point);
      if (aCmpBLeft < 0) return 1;
      if (aCmpBLeft > 0) return -1;
      const int bCmpARight = compare_point(b, *a->rightSE->point);
      if (bCmpARight != 0) return bCmpARight;
      return -1;
    }
    if (alx > blx) {
      if (aly < bly && aly < bry) return -1;
      if (aly > bly && aly > bry) return 1;
      const int bCmpALeft = compare_point(b, *a->leftSE->point);
      if (bCmpALeft != 0) return bCmpALeft;
      const int aCmpBRight = compare_point(a, *b->rightSE->point);
      if (aCmpBRight < 0) return 1;
      if (aCmpBRight > 0) return -1;
      return 1;
    }
    if (aly < bly) return -1;
    if (aly > bly) return 1;
    if (arx < brx) {
      const int bCmpARight = compare_point(b, *a->rightSE->point);
      if (bCmpARight != 0) return bCmpARight;
    }
    if (arx > brx) {
      const int aCmpBRight = compare_point(a, *b->rightSE->point);
      if (aCmpBRight < 0) return 1;
      if (aCmpBRight > 0) return -1;
    }
    if (arx != brx) {
      const double ay = ary - aly;
      const double ax = arx - alx;
      const double by = bry - bly;
      const double bx = brx - blx;
      if (ay > ax && by < bx) return 1;
      if (ay < ax && by > bx) return -1;
    }
    if (arx > brx) return 1;
    if (arx < brx) return -1;
    if (ary < bry) return -1;
    if (ary > bry) return 1;
    if (a->id < b->id) return -1;
    if (a->id > b->id) return 1;
    return 0;
  }
  static void replace_right_se(Segment* s, Event* newRightSE) {
    s->rightSE = newRightSE;
    s->rightSE->segment = s;
    s->rightSE->otherSE = s->leftSE;
    s->leftSE->otherSE = s->rightSE;
  }
  static void swap_events(Segment* s) {
    Event* tmp = s->rightSE;
    s->rightSE = s->leftSE;
    s->leftSE = tmp;
    s->leftSE->isLeft = true;
    s->rightSE->isLeft = false;
    for (int& w : s->windings) w *= -1;
  }
  /// getIntersection: the first non-trivial intersection, or none. The result
  /// is an existing endpoint or a fresh rounded point.
  Pt* get_intersection(Segment* self, Segment* other) {
    const BBox tBbox = seg_bbox(self);
    const BBox oBbox = seg_bbox(other);
    const std::optional<BBox> overlap = bbox_overlap(tBbox, oBbox);
    if (!overlap) return nullptr;
    Pt* tlp = self->leftSE->point;
    Pt* trp = self->rightSE->point;
    Pt* olp = other->leftSE->point;
    Pt* orp = other->rightSE->point;
    const bool touchesOtherLSE = is_in_bbox(tBbox, *olp) && compare_point(self, *olp) == 0;
    const bool touchesThisLSE = is_in_bbox(oBbox, *tlp) && compare_point(other, *tlp) == 0;
    const bool touchesOtherRSE = is_in_bbox(tBbox, *orp) && compare_point(self, *orp) == 0;
    const bool touchesThisRSE = is_in_bbox(oBbox, *trp) && compare_point(other, *trp) == 0;
    if (touchesThisLSE && touchesOtherLSE) {
      if (touchesThisRSE && !touchesOtherRSE) return trp;
      if (!touchesThisRSE && touchesOtherRSE) return orp;
      return nullptr;
    }
    if (touchesThisLSE) {
      if (touchesOtherRSE && tlp->x == orp->x && tlp->y == orp->y) return nullptr;
      return tlp;
    }
    if (touchesOtherLSE) {
      if (touchesThisRSE && trp->x == olp->x && trp->y == olp->y) return nullptr;
      return olp;
    }
    if (touchesThisRSE && touchesOtherRSE) return nullptr;
    if (touchesThisRSE) return trp;
    if (touchesOtherRSE) return orp;
    const std::optional<XY> pt = line_intersection(*tlp, XY{trp->x - tlp->x, trp->y - tlp->y}, *olp,
                                                   XY{orp->x - olp->x, orp->y - olp->y});
    if (!pt) return nullptr;
    if (!is_in_bbox(*overlap, Pt{pt->x, pt->y, {}})) return nullptr;
    return round_pt(pt->x, pt->y);
  }
  std::vector<Event*> split(Segment* self, Pt* point) {
    std::vector<Event*> newEvents;
    const bool alreadyLinked = !point->events.empty();
    Event* newLeftSE = make_event(point, true);
    Event* newRightSE = make_event(point, false);
    Event* oldRightSE = self->rightSE;
    replace_right_se(self, newRightSE);
    newEvents.push_back(newRightSE);
    newEvents.push_back(newLeftSE);
    Segment* newSeg = make_segment(newLeftSE, oldRightSE, self->rings, self->windings);
    if (compare_points(*newSeg->leftSE->point, *newSeg->rightSE->point) > 0) swap_events(newSeg);
    if (compare_points(*self->leftSE->point, *self->rightSE->point) > 0) swap_events(self);
    if (alreadyLinked) {
      check_for_consuming(newLeftSE);
      check_for_consuming(newRightSE);
    }
    return newEvents;
  }
  void consume(Segment* self, Segment* other) {
    Segment* consumer = self;
    Segment* consumee = other;
    while (consumer->consumedBy != nullptr) consumer = consumer->consumedBy;
    while (consumee->consumedBy != nullptr) consumee = consumee->consumedBy;
    const int c = compare_segments(consumer, consumee);
    if (c == 0) return;
    if (c > 0) std::swap(consumer, consumee);
    if (consumer->prev == consumee) std::swap(consumer, consumee);
    for (std::size_t i = 0; i < consumee->rings.size(); ++i) {
      RingIn* ring = consumee->rings[i];
      const int winding = consumee->windings[i];
      const auto it = std::ranges::find(consumer->rings, ring);
      if (it == consumer->rings.end()) {
        consumer->rings.push_back(ring);
        consumer->windings.push_back(winding);
      } else {
        consumer->windings[static_cast<std::size_t>(it - consumer->rings.begin())] += winding;
      }
    }
    consumee->rings.clear();
    consumee->windings.clear();
    consumee->consumedBy = consumer;
    consumee->leftSE->consumedBy = consumer->leftSE;
    consumee->rightSE->consumedBy = consumer->rightSE;
  }
  Segment* prev_in_result(Segment* s) {
    if (s->prevInResultSet) return s->prevInResultV;
    Segment* v = nullptr;
    if (s->prev == nullptr) v = nullptr;
    else if (is_in_result(s->prev)) v = s->prev;
    else v = prev_in_result(s->prev);
    s->prevInResultSet = true;
    s->prevInResultV = v;
    return v;
  }
  State* before_state(Segment* s) {
    if (s->beforeStateV != nullptr) return s->beforeStateV;
    if (s->prev == nullptr) {
      states_.push_back(std::make_unique<State>());
      s->beforeStateV = states_.back().get();
    } else {
      Segment* seg = s->prev->consumedBy != nullptr ? s->prev->consumedBy : s->prev;
      s->beforeStateV = after_state(seg);
    }
    return s->beforeStateV;
  }
  State* after_state(Segment* s) {
    if (s->afterStateV != nullptr) return s->afterStateV;
    const State* before = before_state(s);
    states_.push_back(std::make_unique<State>());
    State* after = states_.back().get();
    after->rings = before->rings;
    after->windings = before->windings;
    s->afterStateV = after;
    for (std::size_t i = 0; i < s->rings.size(); ++i) {
      RingIn* ring = s->rings[i];
      const int winding = s->windings[i];
      const auto it = std::ranges::find(after->rings, ring);
      if (it == after->rings.end()) {
        after->rings.push_back(ring);
        after->windings.push_back(winding);
      } else {
        after->windings[static_cast<std::size_t>(it - after->rings.begin())] += winding;
      }
    }
    std::vector<PolyIn*> polysAfter;
    std::vector<PolyIn*> polysExclude;
    for (std::size_t i = 0; i < after->rings.size(); ++i) {
      if (after->windings[i] == 0) continue;
      RingIn* ring = after->rings[i];
      PolyIn* poly = ring->poly;
      if (std::ranges::find(polysExclude, poly) != polysExclude.end()) continue;
      if (ring->isExterior) {
        polysAfter.push_back(poly);
      } else {
        if (std::ranges::find(polysExclude, poly) == polysExclude.end()) polysExclude.push_back(poly);
        const auto it = std::ranges::find(polysAfter, ring->poly);
        if (it != polysAfter.end()) polysAfter.erase(it);
      }
    }
    for (PolyIn* p : polysAfter) {
      MultiPolyIn* mp = p->multiPoly;
      if (std::ranges::find(after->multiPolys, mp) == after->multiPolys.end()) after->multiPolys.push_back(mp);
    }
    return after;
  }
  bool is_in_result(Segment* s) {
    if (s->consumedBy != nullptr) return false;
    if (s->isInResultV >= 0) return s->isInResultV == 1;
    const std::vector<MultiPolyIn*>& before = before_state(s)->multiPolys;
    const std::vector<MultiPolyIn*>& after = after_state(s)->multiPolys;
    bool in = false;
    switch (type_) {
      case OpType::union_: in = before.empty() != after.empty(); break;
      case OpType::intersection: {
        const std::size_t least = std::min(before.size(), after.size());
        const std::size_t most = before.size() < after.size() ? after.size() : before.size();
        in = most == numMultiPolys_ && least < most;
        break;
      }
      case OpType::xor_: {
        const auto diff = before.size() > after.size() ? before.size() - after.size() : after.size() - before.size();
        in = diff % 2 == 1;
        break;
      }
      case OpType::difference: {
        const auto justSubject = [](const std::vector<MultiPolyIn*>& mps) { return mps.size() == 1 && mps[0]->isSubject; };
        in = justSubject(before) != justSubject(after);
        break;
      }
    }
    s->isInResultV = in ? 1 : 0;
    return in;
  }

  // ── SweepLine ──
  std::vector<Event*> process(Event* event, SplayTree<Event*>& queue, SplayTree<Segment*>& tree,
                              std::vector<Segment*>& segments) {
    Segment* segment = event->segment;
    std::vector<Event*> newEvents;
    if (event->consumedBy != nullptr) {
      if (event->isLeft) queue.remove(event->otherSE);
      else tree.remove(segment);
      return newEvents;
    }
    auto* node = event->isLeft ? tree.add(segment) : tree.find(segment);
    if (node == nullptr) throw std::runtime_error("polygon-clipping: unable to find a segment in the sweep line tree");
    auto* prevNode = node;
    auto* nextNode = node;
    Segment* prevSeg = nullptr;
    bool prevSet = false;
    Segment* nextSeg = nullptr;
    bool nextSet = false;
    while (!prevSet) {
      prevNode = tree.prev(prevNode);
      if (prevNode == nullptr) {
        prevSeg = nullptr;
        prevSet = true;
      } else if (prevNode->key->consumedBy == nullptr) {
        prevSeg = prevNode->key;
        prevSet = true;
      }
    }
    while (!nextSet) {
      nextNode = tree.next(nextNode);
      if (nextNode == nullptr) {
        nextSeg = nullptr;
        nextSet = true;
      } else if (nextNode->key->consumedBy == nullptr) {
        nextSeg = nextNode->key;
        nextSet = true;
      }
    }
    if (event->isLeft) {
      Pt* prevMySplitter = nullptr;
      if (prevSeg != nullptr) {
        Pt* prevInter = get_intersection(prevSeg, segment);
        if (prevInter != nullptr) {
          if (!is_an_endpoint(segment, *prevInter)) prevMySplitter = prevInter;
          if (!is_an_endpoint(prevSeg, *prevInter)) {
            for (Event* e : split_safely(prevSeg, prevInter, queue, tree)) newEvents.push_back(e);
          }
        }
      }
      Pt* nextMySplitter = nullptr;
      if (nextSeg != nullptr) {
        Pt* nextInter = get_intersection(nextSeg, segment);
        if (nextInter != nullptr) {
          if (!is_an_endpoint(segment, *nextInter)) nextMySplitter = nextInter;
          if (!is_an_endpoint(nextSeg, *nextInter)) {
            for (Event* e : split_safely(nextSeg, nextInter, queue, tree)) newEvents.push_back(e);
          }
        }
      }
      if (prevMySplitter != nullptr || nextMySplitter != nullptr) {
        Pt* mySplitter = nullptr;
        if (prevMySplitter == nullptr) mySplitter = nextMySplitter;
        else if (nextMySplitter == nullptr) mySplitter = prevMySplitter;
        else mySplitter = compare_points(*prevMySplitter, *nextMySplitter) <= 0 ? prevMySplitter : nextMySplitter;
        queue.remove(segment->rightSE);
        newEvents.push_back(segment->rightSE);
        for (Event* e : split(segment, mySplitter)) newEvents.push_back(e);
      }
      if (!newEvents.empty()) {
        tree.remove(segment);
        newEvents.push_back(event);
      } else {
        segments.push_back(segment);
        segment->prev = prevSeg;
      }
    } else {
      if (prevSeg != nullptr && nextSeg != nullptr) {
        Pt* inter = get_intersection(prevSeg, nextSeg);
        if (inter != nullptr) {
          if (!is_an_endpoint(prevSeg, *inter)) {
            for (Event* e : split_safely(prevSeg, inter, queue, tree)) newEvents.push_back(e);
          }
          if (!is_an_endpoint(nextSeg, *inter)) {
            for (Event* e : split_safely(nextSeg, inter, queue, tree)) newEvents.push_back(e);
          }
        }
      }
      tree.remove(segment);
    }
    return newEvents;
  }
  std::vector<Event*> split_safely(Segment* seg, Pt* pt, SplayTree<Event*>& queue, SplayTree<Segment*>& tree) {
    tree.remove(seg);
    Event* rightSE = seg->rightSE;
    queue.remove(rightSE);
    std::vector<Event*> newEvents = split(seg, pt);
    newEvents.push_back(rightSE);
    if (seg->consumedBy == nullptr) tree.add(seg);
    return newEvents;
  }

  // ── output ──
  RingOut* make_ring_out(std::vector<Event*> events) {
    ringsOut_.push_back(std::make_unique<RingOut>());
    RingOut* r = ringsOut_.back().get();
    r->events = std::move(events);
    for (Event* e : r->events) e->segment->ringOut = r;
    return r;
  }
  std::vector<RingOut*> ring_out_factory(const std::vector<Segment*>& allSegments) {
    std::vector<RingOut*> ringsOut;
    for (Segment* segment : allSegments) {
      if (!is_in_result(segment) || segment->ringOut != nullptr) continue;
      Event* prevEvent = nullptr;
      Event* event = segment->leftSE;
      Event* nextEvent = segment->rightSE;
      std::vector<Event*> events{event};
      const Pt* startingPoint = event->point;
      struct IntersectionLE {
        std::size_t index;
        const Pt* point;
      };
      std::vector<IntersectionLE> intersectionLEs;
      for (;;) {
        prevEvent = event;
        event = nextEvent;
        events.push_back(event);
        if (event->point == startingPoint) break;
        for (;;) {
          std::vector<Event*> availableLEs = available_linked_events(event);
          if (availableLEs.empty()) throw std::runtime_error("polygon-clipping: unable to complete an output ring");
          if (availableLEs.size() == 1) {
            nextEvent = availableLEs[0]->otherSE;
            break;
          }
          std::optional<std::size_t> indexLE;
          for (std::size_t j = 0; j < intersectionLEs.size(); ++j) {
            if (intersectionLEs[j].point == event->point) {
              indexLE = j;
              break;
            }
          }
          if (indexLE) {
            const IntersectionLE intersectionLE = intersectionLEs[*indexLE];
            intersectionLEs.resize(*indexLE);
            std::vector<Event*> ringEvents(events.begin() + static_cast<std::ptrdiff_t>(intersectionLE.index), events.end());
            events.resize(intersectionLE.index);
            ringEvents.insert(ringEvents.begin(), ringEvents[0]->otherSE);
            std::ranges::reverse(ringEvents);
            ringsOut.push_back(make_ring_out(std::move(ringEvents)));
            continue;
          }
          intersectionLEs.push_back({events.size(), event->point});
          // getLeftmostComparator(prevEvent): cached sine / cosine per linked event.
          struct SC {
            double sine, cosine;
          };
          std::vector<std::pair<Event*, SC>> cache;
          const Pt& shared = *event->point;
          const Pt& base = *prevEvent->point;
          const auto get = [&](Event* e) -> SC {
            for (const auto& [k, v] : cache) {
              if (k == e) return v;
            }
            const Pt& nextPt = *e->otherSE->point;
            const SC v{sine_of_angle(shared, base, nextPt), cosine_of_angle(shared, base, nextPt)};
            cache.emplace_back(e, v);
            return v;
          };
          v8_sort(availableLEs, [&](Event* a, Event* b) -> double {
            const SC ca = get(a);
            const SC cb = get(b);
            if (ca.sine >= 0 && cb.sine >= 0) {
              if (ca.cosine < cb.cosine) return 1;
              if (ca.cosine > cb.cosine) return -1;
              return 0;
            }
            if (ca.sine < 0 && cb.sine < 0) {
              if (ca.cosine < cb.cosine) return -1;
              if (ca.cosine > cb.cosine) return 1;
              return 0;
            }
            if (cb.sine < ca.sine) return -1;
            if (cb.sine > ca.sine) return 1;
            return 0;
          });
          nextEvent = availableLEs[0]->otherSE;
          break;
        }
      }
      ringsOut.push_back(make_ring_out(std::move(events)));
    }
    return ringsOut;
  }
  bool is_exterior_ring(RingOut* r) {
    if (r->isExteriorV < 0) {
      RingOut* enclosing = enclosing_ring(r);
      r->isExteriorV = (enclosing != nullptr ? !is_exterior_ring(enclosing) : true) ? 1 : 0;
    }
    return r->isExteriorV == 1;
  }
  RingOut* enclosing_ring(RingOut* r) {
    if (!r->enclosingSet) {
      r->enclosingV = calc_enclosing_ring(r);
      r->enclosingSet = true;
    }
    return r->enclosingV;
  }
  RingOut* calc_enclosing_ring(RingOut* r) {
    Event* leftMostEvt = r->events[0];
    for (std::size_t i = 1; i < r->events.size(); ++i) {
      Event* evt = r->events[i];
      if (compare_events(leftMostEvt, evt) > 0) leftMostEvt = evt;
    }
    Segment* prevSeg = prev_in_result(leftMostEvt->segment);
    Segment* prevPrevSeg = prevSeg != nullptr ? prev_in_result(prevSeg) : nullptr;
    for (;;) {
      if (prevSeg == nullptr) return nullptr;
      if (prevPrevSeg == nullptr) return prevSeg->ringOut;
      if (prevPrevSeg->ringOut != prevSeg->ringOut) {
        if (enclosing_ring(prevPrevSeg->ringOut) != prevSeg->ringOut) return prevSeg->ringOut;
        return enclosing_ring(prevSeg->ringOut);
      }
      prevSeg = prev_in_result(prevPrevSeg);
      prevPrevSeg = prevSeg != nullptr ? prev_in_result(prevSeg) : nullptr;
    }
  }
  std::optional<Ring> ring_geom(RingOut* r) {
    const Pt* prevPt = r->events[0]->point;
    std::vector<const Pt*> points{prevPt};
    for (std::size_t i = 1; i + 1 < r->events.size(); ++i) {
      const Pt* pt = r->events[i]->point;
      const Pt* nextPt = r->events[i + 1]->point;
      if (compare_vector_angles(*pt, *prevPt, *nextPt) == 0) continue;
      points.push_back(pt);
      prevPt = pt;
    }
    if (points.size() == 1) return std::nullopt;
    const Pt* pt = points[0];
    const Pt* nextPt = points[1];
    if (compare_vector_angles(*pt, *prevPt, *nextPt) == 0) points.erase(points.begin());
    points.push_back(points[0]);
    const bool ext = is_exterior_ring(r);
    Ring out;
    if (ext) {
      for (const Pt* p : points) out.push_back({p->x, p->y});
    } else {
      for (std::size_t i = points.size(); i-- > 0;) out.push_back({points[i]->x, points[i]->y});
    }
    return out;
  }
  MultiPolygon multi_poly_out(const std::vector<RingOut*>& rings) {
    std::vector<PolyOut*> polys;
    for (RingOut* ring : rings) {
      if (ring->poly != nullptr) continue;
      if (is_exterior_ring(ring)) {
        polys.push_back(make_poly_out(ring));
      } else {
        RingOut* enclosing = enclosing_ring(ring);
        if (enclosing->poly == nullptr) polys.push_back(make_poly_out(enclosing));
        enclosing->poly->interiorRings.push_back(ring);
        ring->poly = enclosing->poly;
      }
    }
    MultiPolygon geom;
    for (PolyOut* p : polys) {
      std::optional<Ring> ext = ring_geom(p->exteriorRing);
      if (!ext) continue;
      Polygon poly{std::move(*ext)};
      for (RingOut* in : p->interiorRings) {
        if (std::optional<Ring> g = ring_geom(in)) poly.push_back(std::move(*g));
      }
      geom.push_back(std::move(poly));
    }
    return geom;
  }
  PolyOut* make_poly_out(RingOut* exterior) {
    polysOut_.push_back(std::make_unique<PolyOut>());
    PolyOut* p = polysOut_.back().get();
    p->exteriorRing = exterior;
    exterior->poly = p;
    return p;
  }

  OpType type_;
  std::size_t numMultiPolys_ = 0;
  int segmentId_ = 0;
  CoordRounder xr_;
  CoordRounder yr_;
  std::vector<std::unique_ptr<Pt>> points_;
  std::vector<std::unique_ptr<Event>> events_;
  std::vector<std::unique_ptr<Segment>> segments_;
  std::vector<std::unique_ptr<RingIn>> ringsIn_;
  std::vector<std::unique_ptr<PolyIn>> polysIn_;
  std::vector<std::unique_ptr<MultiPolyIn>> multisIn_;
  std::vector<std::unique_ptr<RingOut>> ringsOut_;
  std::vector<std::unique_ptr<PolyOut>> polysOut_;
  std::vector<std::unique_ptr<State>> states_;
};

}  // namespace

MultiPolygon run(OpType type, const MultiPolygon& subject, const std::vector<MultiPolygon>& clipping) {
  Operation op(type);
  return op.run(subject, clipping);
}

}  // namespace premation::scene::pc
